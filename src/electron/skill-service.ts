import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { getManagedSurfaces, getScanSurfaces, loadConfig, normalizeSettingsForSave, saveConfig } from './config.js'
import type {
  AppSnapshot,
  ManagedLinkStatus,
  ManagedSurfaceDefinition,
  MigrationPlanItem,
  MigrationPreview,
  RunMigrationRequest,
  ScanSurfaceDefinition,
  ScanSurfaceId,
  SaveSettingsRequest,
  SkillLocation,
  SkillRow,
  SkillState,
  SnapshotResponse,
  ToggleSkillRequest,
} from '../shared/models.js'

type EntryKind = 'link' | 'directory' | 'file'

interface RawEntry {
  name: string
  path: string
  kind: EntryKind
  realPath: string | null
  targetPath: string | null
}

interface ScanState {
  repositoryEntries: Map<string, RawEntry>
  scanSurfaceEntries: Map<ScanSurfaceId, Map<string, RawEntry>>
  managedSurfaceEntries: Map<ManagedSurfaceDefinition['id'], Map<string, RawEntry>>
}

interface SourceAssessment {
  kind: 'migratable' | 'conflict' | 'invalid'
  message: string
  sourcePath: string | null
  sourceSurfaceName: string | null
}

interface MigrationCleanupAction {
  skillName: string
  surfaceId: ScanSurfaceId
  surfaceName: string
  entryPath: string
}

interface MigrationPlan extends MigrationPreview {
  cleanupActions: MigrationCleanupAction[]
}

interface StagedCleanupEntry {
  finalPath: string
  tempPath: string
}

export class SkillService {
  constructor(private readonly userDataPath: string) {}

  async getSnapshot(): Promise<AppSnapshot> {
    const config = await loadConfig(this.userDataPath)
    return this.createSnapshot(config)
  }

  async saveSettings(request: SaveSettingsRequest): Promise<SnapshotResponse> {
    try {
      const currentConfig = await loadConfig(this.userDataPath)
      const currentSnapshot = await this.createSnapshot(currentConfig)
      const settings = normalizeSettingsForSave(request)
      const nextConfig = {
        ...currentConfig,
        settings,
        managedSurfaces: getManagedSurfaces(settings),
        scanSurfaces: getScanSurfaces(settings),
      }

      await saveConfig(nextConfig)

      try {
        await syncManagedOutputSelection(currentConfig.managedSurfaces, nextConfig.managedSurfaces, currentSnapshot.skills)
        return await this.buildResponse(true, 'Settings saved successfully.')
      } catch (error) {
        return await this.buildResponse(false, `Settings were saved, but managed output sync failed: ${getErrorMessage(error)}`)
      }
    } catch (error) {
      return this.buildErrorResponse(getErrorMessage(error))
    }
  }

  private async createSnapshot(config: Awaited<ReturnType<typeof loadConfig>>): Promise<AppSnapshot> {
    const scanState = await scanStateForRepository(config.repositoryPath, config.scanSurfaces, config.managedSurfaces)
    const repositoryExists = await pathExists(config.repositoryPath)
    const migration = buildMigrationPreview(config.repositoryPath, config.scanSurfaces, config.managedSurfaces, scanState)

    const skillNames = new Set<string>(scanState.repositoryEntries.keys())
    for (const entries of scanState.scanSurfaceEntries.values()) {
      for (const skillName of entries.keys()) {
        skillNames.add(skillName)
      }
    }

    for (const entries of scanState.managedSurfaceEntries.values()) {
      for (const skillName of entries.keys()) {
        skillNames.add(skillName)
      }
    }

    const skills = [...skillNames]
      .map((skillName) => buildSkillRow(skillName, config.scanSurfaces, config.managedSurfaces, scanState))
      .sort((left, right) => {
        const stateOrder: Record<SkillState, number> = {
          invalid: 0,
          conflict: 1,
          partial: 2,
          needsMigration: 3,
          enabled: 4,
          disabled: 5,
        }

        if (stateOrder[left.state] !== stateOrder[right.state]) {
          return stateOrder[left.state] - stateOrder[right.state]
        }

        return left.skillName.localeCompare(right.skillName)
      })

    return {
      repositoryPath: config.repositoryPath,
      repositoryExists,
      settings: config.settings,
      settingsDefaults: config.settingsDefaults,
      scanSurfaces: config.scanSurfaces,
      managedSurfaces: config.managedSurfaces,
      skills,
      migration,
      lastUpdated: new Date().toISOString(),
    }
  }

  async toggleSkill(request: ToggleSkillRequest): Promise<SnapshotResponse> {
    try {
      const config = await loadConfig(this.userDataPath)
      const repositoryEntryPath = normalizeFsPath(path.join(config.repositoryPath, request.skillName))
      const repositoryEntry = await readEntry(request.skillName, repositoryEntryPath)

      if (!repositoryEntry || repositoryEntry.kind === 'file') {
        return this.buildResponse(false, `${request.skillName} is not present in the central repository. Run migration first.`)
      }

      const currentEntries = await readManagedEntries(request.skillName, config.managedSurfaces)
      const result = request.enabled
        ? await enableManagedSkill(request.skillName, repositoryEntryPath, config.managedSurfaces, currentEntries)
        : await disableManagedSkill(request.skillName, repositoryEntryPath, config.managedSurfaces, currentEntries)

      return this.buildResponse(result.ok, result.message)
    } catch (error) {
      return this.buildErrorResponse(getErrorMessage(error))
    }
  }

  async runMigration(request?: RunMigrationRequest): Promise<SnapshotResponse> {
    try {
      const config = await loadConfig(this.userDataPath)
      const scanState = await scanStateForRepository(config.repositoryPath, config.scanSurfaces, config.managedSurfaces)
      const migration = buildMigrationPlan(config.repositoryPath, config.scanSurfaces, config.managedSurfaces, scanState)

      if (!migration.canRun) {
        return this.buildResponse(false, 'Migration is blocked. Resolve the listed issues first.')
      }

      if (migration.forceRequired && !request?.forceCleanup) {
        return this.buildResponse(
          false,
          `Migration needs confirmation because ${migration.cleanupCount} conflicting filesystem entries will be removed before sync.`,
        )
      }

      if (!migration.items.length && !migration.cleanupActions.length) {
        return this.buildResponse(true, 'Nothing needs migration or cleanup.')
      }

      await fs.mkdir(config.repositoryPath, { recursive: true })
      const movedItems: MigrationPlanItem[] = []
      const linkedSkills: MigrationPlanItem[] = []
      const stagedCleanupEntries: StagedCleanupEntry[] = []
      const managedSurfacePaths = new Set(config.managedSurfaces.map((surface) => toComparisonKey(surface.path)))
      const skillsToSync = dedupeSkillNames([
        ...migration.items.map((item) => item.skillName),
        ...migration.cleanupActions
          .filter((action) => managedSurfacePaths.has(toComparisonKey(path.dirname(action.entryPath))))
          .map((action) => action.skillName),
      ])

      try {
        for (const item of migration.items) {
          await fs.rename(item.sourcePath, item.repositoryPath)
          movedItems.push(item)
        }

        const stagedEntries = await stageCleanupEntries(migration.cleanupActions)
        stagedCleanupEntries.push(...stagedEntries)

        for (const item of migration.items) {
          await removeLegacyEntries(item.skillName, dedupeSurfacePaths([...config.scanSurfaces, ...config.managedSurfaces]))
        }

        for (const skillName of skillsToSync) {
          if (config.managedSurfaces.length === 0) {
            continue
          }

          const repositoryPath = normalizeFsPath(path.join(config.repositoryPath, skillName))
          const repositoryEntry = await readEntry(skillName, repositoryPath)
          if (!repositoryEntry || repositoryEntry.kind === 'file') {
            throw new Error(`${skillName} is not present as a directory in the central repository after migration.`)
          }

          const currentEntries = await readManagedEntries(skillName, config.managedSurfaces)
          const shouldTrackRollback = hasManagedLinkDrift(repositoryPath, config.managedSurfaces, currentEntries)
          const linkResult = await enableManagedSkill(skillName, repositoryPath, config.managedSurfaces, currentEntries)
          if (!linkResult.ok) {
            throw new Error(linkResult.message)
          }

          if (shouldTrackRollback) {
            linkedSkills.push({
              skillName,
              sourcePath: '',
              sourceSurfaceName: '',
              repositoryPath,
            })
          }
        }

        for (const stagedEntry of stagedCleanupEntries) {
          await fs.rm(stagedEntry.tempPath, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
        }
      } catch (error) {
        for (const item of [...linkedSkills].reverse()) {
          await rollbackManagedLinks(item.skillName, item.repositoryPath, config.managedSurfaces)
        }

        for (const item of [...movedItems].reverse()) {
          if (await pathEntryExists(item.repositoryPath) && !(await pathEntryExists(item.sourcePath))) {
            await fs.rename(item.repositoryPath, item.sourcePath).catch(() => undefined)
          }
        }

        for (const stagedEntry of [...stagedCleanupEntries].reverse()) {
          if (await pathEntryExists(stagedEntry.finalPath)) {
            await fs.rm(stagedEntry.finalPath, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
          }

          if (await pathEntryExists(stagedEntry.tempPath)) {
            await fs.rename(stagedEntry.tempPath, stagedEntry.finalPath).catch(() => undefined)
          }
        }

        throw error
      }

      if (migration.items.length > 0 && migration.cleanupActions.length > 0) {
          return this.buildResponse(
            true,
            `Migrated ${migration.items.length} skills, removed ${migration.cleanupActions.length} conflicting filesystem entries, and synced managed links to the central repository.`,
          )
        }

      if (migration.items.length > 0) {
        return this.buildResponse(true, `Migrated ${migration.items.length} skills into the central repository and synced managed links.`)
      }

      return this.buildResponse(
        true,
        `Removed ${migration.cleanupActions.length} conflicting filesystem entries and synced managed links to the central repository.`,
      )
    } catch (error) {
      return this.buildErrorResponse(getErrorMessage(error))
    }
  }

  private async buildResponse(ok: boolean, message: string): Promise<SnapshotResponse> {
    return {
      ok,
      message,
      snapshot: await this.getSnapshot(),
    }
  }

  private buildErrorResponse(message: string): SnapshotResponse {
    return {
      ok: false,
      message,
      snapshot: null,
    }
  }
}

async function scanStateForRepository(
  repositoryPath: string,
  scanSurfaces: ScanSurfaceDefinition[],
  managedSurfaces: ManagedSurfaceDefinition[],
): Promise<ScanState> {
  const repositoryEntries = await scanDirectory(repositoryPath, [])
  const scanSurfaceEntries = new Map<ScanSurfaceId, Map<string, RawEntry>>()
  const managedSurfaceEntries = new Map<ManagedSurfaceDefinition['id'], Map<string, RawEntry>>()

  const scannedEntries = await Promise.all(
    scanSurfaces.map(async (surface) => [surface.id, await scanDirectory(surface.path, surface.reservedNames ?? [])] as const),
  )
  const managedEntries = await Promise.all(
    managedSurfaces.map(async (surface) => [surface.id, await scanDirectory(surface.path, [])] as const),
  )

  for (const [surfaceId, entries] of scannedEntries) {
    scanSurfaceEntries.set(surfaceId, entries)
  }

  for (const [surfaceId, entries] of managedEntries) {
    managedSurfaceEntries.set(surfaceId, entries)
  }

  return {
    repositoryEntries,
    scanSurfaceEntries,
    managedSurfaceEntries,
  }
}

function buildSkillRow(
  skillName: string,
  scanSurfaces: ScanSurfaceDefinition[],
  managedSurfaces: ManagedSurfaceDefinition[],
  scanState: ScanState,
): SkillRow {
  const repositoryEntry = scanState.repositoryEntries.get(skillName)
  const repositoryPath = repositoryEntry?.path ?? null
  const scanLocations = buildLocations(skillName, scanSurfaces, scanState.scanSurfaceEntries)
  const managedLocations = buildLocations(skillName, managedSurfaces, scanState.managedSurfaceEntries)
  const locations = dedupeLocations([...scanLocations, ...managedLocations])
  const legacyLocations = scanLocations.filter(
    (location) => !managedSurfaces.some((surface) => samePath(path.dirname(location.entryPath), surface.path)),
  )
  const managedLinks = managedSurfaces.map((surface) =>
    classifyManagedLink(skillName, surface, scanState.managedSurfaceEntries.get(surface.id)?.get(skillName), repositoryPath),
  )
  const managedEntries = managedSurfaces.map((surface) => scanState.managedSurfaceEntries.get(surface.id)?.get(skillName))
  const managedConflictMessages = repositoryEntry
    ? buildManagedConflictMessages(skillName, managedSurfaces, managedEntries, repositoryEntry.path)
    : []
  const legacyConflictMessages = repositoryEntry
    ? buildLegacyConflictMessages(skillName, legacyLocations, repositoryEntry.path)
    : []

  if (managedConflictMessages.length || legacyConflictMessages.length) {
    return {
      skillName,
      state: 'invalid',
      repositoryPath,
      canEnable: false,
      canDisable: canRemoveManagedEntries(managedEntries),
      message: [...managedConflictMessages, ...legacyConflictMessages].join(' '),
      managedLinks,
      locations,
    }
  }

  if (repositoryEntry) {
    if (!managedLinks.length) {
      return {
        skillName,
        state: 'disabled',
        repositoryPath,
        canEnable: false,
        canDisable: false,
        message: `${skillName} is stored centrally, but no managed outputs are configured.`,
        managedLinks,
        locations,
      }
    }

    const enabledCount = managedLinks.filter((link) => link.state === 'enabled').length
    const missingCount = managedLinks.filter((link) => link.state === 'missing').length

    if (enabledCount === managedLinks.length) {
      return {
        skillName,
        state: 'enabled',
        repositoryPath,
        canEnable: false,
        canDisable: true,
        message: `${skillName} is linked into all configured managed outputs.`,
        managedLinks,
        locations,
      }
    }

    if (missingCount === managedLinks.length) {
      return {
        skillName,
        state: 'disabled',
        repositoryPath,
        canEnable: managedLinks.length > 0,
        canDisable: false,
        message: `${skillName} is stored centrally but currently disabled for all configured managed outputs.`,
        managedLinks,
        locations,
      }
    }

    return {
      skillName,
      state: 'partial',
      repositoryPath,
      canEnable: true,
      canDisable: canRemoveManagedEntries(managedEntries),
      message: `${skillName} is only linked into part of the managed output set. Enable to repair all links, or disable to clear them.`,
      managedLinks,
      locations,
    }
  }

  const sourceAssessment = assessLegacySources(skillName, locations)

  if (sourceAssessment.kind === 'migratable') {
    return {
      skillName,
      state: 'needsMigration',
      repositoryPath: null,
      canEnable: false,
      canDisable: false,
      message: sourceAssessment.message,
      managedLinks,
      locations,
    }
  }

  return {
    skillName,
    state: sourceAssessment.kind === 'conflict' ? 'conflict' : 'invalid',
    repositoryPath: null,
    canEnable: false,
    canDisable: false,
    message: sourceAssessment.message,
    managedLinks,
    locations,
  }
}

function buildLocations<TSurface extends Pick<ScanSurfaceDefinition, 'id' | 'name'>>(
  skillName: string,
  surfaces: TSurface[],
  surfaceEntries: Map<TSurface['id'], Map<string, RawEntry>>,
): SkillLocation[] {
  return surfaces.flatMap((surface) => {
    const entry = surfaceEntries.get(surface.id)?.get(skillName)
    if (!entry) {
      return []
    }

    return [{
      surfaceId: surface.id,
      surfaceName: surface.name,
      entryPath: entry.path,
      kind: entry.kind,
      targetPath: entry.targetPath,
      realPath: entry.realPath,
    } satisfies SkillLocation]
  })
}

function classifyManagedLink(
  skillName: string,
  surface: ManagedSurfaceDefinition,
  entry: RawEntry | undefined,
  repositoryPath: string | null,
): ManagedLinkStatus {
  const entryPath = normalizeFsPath(path.join(surface.path, skillName))

  if (!entry) {
    return {
      surfaceId: surface.id,
      surfaceName: surface.name,
      entryPath,
      state: 'missing',
      targetPath: repositoryPath,
      message: `${surface.name} does not currently contain ${skillName}.`,
    }
  }

  if (repositoryPath && entry.kind === 'link' && entry.realPath && samePath(entry.realPath, repositoryPath)) {
    return {
      surfaceId: surface.id,
      surfaceName: surface.name,
      entryPath,
      state: 'enabled',
      targetPath: entry.realPath,
      message: `${surface.name} is linked to the central repository copy.`,
    }
  }

  const detail = entry.kind === 'file'
    ? 'contains a file instead of a managed junction.'
    : !entry.realPath
      ? 'contains a broken junction.'
      : repositoryPath
        ? `points to ${entry.realPath} instead of the central repository.`
        : `still hosts ${skillName} outside the central repository.`

  return {
    surfaceId: surface.id,
    surfaceName: surface.name,
    entryPath,
    state: 'invalid',
    targetPath: entry.realPath ?? entry.targetPath,
    message: `${surface.name} ${detail}`,
  }
}

function buildManagedConflictMessages(
  skillName: string,
  managedSurfaces: ManagedSurfaceDefinition[],
  managedEntries: Array<RawEntry | undefined>,
  repositoryPath: string,
): string[] {
  const messages: string[] = []

  managedEntries.forEach((entry, index) => {
    if (!entry) {
      return
    }

    const surface = managedSurfaces[index]
    if (entry.kind === 'file') {
      messages.push(`${skillName}: ${surface.name} contains a file at ${entry.path}.`)
      return
    }

    if (!entry.realPath) {
      messages.push(`${skillName}: ${surface.name} has a broken junction at ${entry.path}.`)
      return
    }

    if (entry.kind !== 'link') {
      messages.push(`${skillName}: ${surface.name} contains a real directory at ${entry.path}.`)
      return
    }

    if (!samePath(entry.realPath, repositoryPath)) {
      messages.push(`${skillName}: ${surface.name} points to ${entry.realPath} instead of ${repositoryPath}.`)
    }
  })

  return messages
}

function buildLegacyConflictMessages(skillName: string, locations: SkillLocation[], repositoryPath: string): string[] {
  return locations.flatMap((location) => {
    if (location.kind === 'file') {
      return [`${skillName}: ${location.surfaceName} contains a file at ${location.entryPath}.`]
    }

    if (!location.realPath) {
      return [`${skillName}: ${location.surfaceName} has a broken junction at ${location.entryPath}.`]
    }

    if (samePath(location.realPath, repositoryPath)) {
      return []
    }

    return [`${skillName}: ${location.surfaceName} still resolves to ${location.realPath} instead of the central repository.`]
  })
}

function dedupeLocations(locations: SkillLocation[]): SkillLocation[] {
  const seen = new Set<string>()
  const deduped: SkillLocation[] = []

  for (const location of locations) {
    const key = toComparisonKey(location.entryPath)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(location)
  }

  return deduped
}

function assessLegacySources(skillName: string, locations: SkillLocation[]): SourceAssessment {
  const fileLocations = locations.filter((location) => location.kind === 'file')
  if (fileLocations.length) {
    return {
      kind: 'invalid',
      message: `${skillName} is blocked because ${fileLocations[0].surfaceName} contains a file at ${fileLocations[0].entryPath}.`,
      sourcePath: null,
      sourceSurfaceName: null,
    }
  }

  const brokenLocations = locations.filter((location) => location.kind === 'link' && !location.realPath)
  if (brokenLocations.length) {
    return {
      kind: 'invalid',
      message: `${skillName} is blocked because ${brokenLocations[0].surfaceName} has a broken junction at ${brokenLocations[0].entryPath}.`,
      sourcePath: null,
      sourceSurfaceName: null,
    }
  }

  const usableLocations = locations.filter((location) => Boolean(location.realPath))
  const uniqueSources = uniquePaths(usableLocations.map((location) => location.realPath!))

  if (uniqueSources.length === 1) {
    const sourcePath = uniqueSources[0]
    const sourceLocation = usableLocations.find((location) => samePath(location.realPath!, sourcePath))

    return {
      kind: 'migratable',
      message: `${skillName} resolves to a single legacy source in ${sourceLocation?.surfaceName}. Run migration to move it into the central repository.`,
      sourcePath,
      sourceSurfaceName: sourceLocation?.surfaceName ?? null,
    }
  }

  if (uniqueSources.length > 1) {
    return {
      kind: 'conflict',
      message: `${skillName} resolves to multiple different legacy sources: ${uniqueSources.join(', ')}.`,
      sourcePath: null,
      sourceSurfaceName: null,
    }
  }

  return {
    kind: 'invalid',
    message: `${skillName} was detected, but no usable source directory could be found for migration.`,
    sourcePath: null,
    sourceSurfaceName: null,
  }
}

function assessRepositoryCleanup(
  skillName: string,
  locations: SkillLocation[],
  repositoryPath: string,
): { blockingIssues: string[]; cleanupWarnings: string[]; cleanupActions: MigrationCleanupAction[] } {
  const blockingIssues: string[] = []
  const cleanupWarnings: string[] = []
  const cleanupActions: MigrationCleanupAction[] = []

  for (const location of locations) {
    if (location.kind === 'file') {
      blockingIssues.push(`${skillName}: ${location.surfaceName} contains a file at ${location.entryPath}.`)
      continue
    }

    if (location.realPath && samePath(location.realPath, repositoryPath)) {
      continue
    }

    if (location.kind === 'link' && !location.realPath) {
      cleanupWarnings.push(`${skillName}: ${location.surfaceName} has a broken junction at ${location.entryPath}; force cleanup will remove it.`)
    } else if (location.realPath) {
      cleanupWarnings.push(
        `${skillName}: ${location.surfaceName} still resolves to ${location.realPath} instead of the central repository; force cleanup will replace it.`,
      )
    } else {
      cleanupWarnings.push(
        `${skillName}: ${location.surfaceName} contains ${location.entryPath} outside the central repository; force cleanup will remove it.`,
      )
    }

    cleanupActions.push({
      skillName,
      surfaceId: location.surfaceId,
      surfaceName: location.surfaceName,
      entryPath: location.entryPath,
    })
  }

  return {
    blockingIssues,
    cleanupWarnings,
    cleanupActions,
  }
}

function buildMigrationPreview(
  repositoryPath: string,
  scanSurfaces: ScanSurfaceDefinition[],
  managedSurfaces: ManagedSurfaceDefinition[],
  scanState: ScanState,
): MigrationPreview {
  const plan = buildMigrationPlan(repositoryPath, scanSurfaces, managedSurfaces, scanState)

  return {
    needed: plan.needed,
    canRun: plan.canRun,
    forceRequired: plan.forceRequired,
    cleanupCount: plan.cleanupCount,
    repositoryPath: plan.repositoryPath,
    items: plan.items,
    issues: plan.issues,
    cleanupWarnings: plan.cleanupWarnings,
  }
}

function buildMigrationPlan(
  repositoryPath: string,
  scanSurfaces: ScanSurfaceDefinition[],
  managedSurfaces: ManagedSurfaceDefinition[],
  scanState: ScanState,
): MigrationPlan {
  const skillNames = new Set<string>()
  const items: MigrationPlanItem[] = []
  const issues: string[] = []
  const cleanupWarnings: string[] = []
  const cleanupActions: MigrationCleanupAction[] = []

  for (const entries of scanState.scanSurfaceEntries.values()) {
    for (const skillName of entries.keys()) {
      skillNames.add(skillName)
    }
  }

  for (const entries of scanState.managedSurfaceEntries.values()) {
    for (const skillName of entries.keys()) {
      skillNames.add(skillName)
    }
  }

  for (const skillName of skillNames) {
    const repositoryEntry = scanState.repositoryEntries.get(skillName)
    const scanLocations = buildLocations(skillName, scanSurfaces, scanState.scanSurfaceEntries)
    const managedLocations = buildLocations(skillName, managedSurfaces, scanState.managedSurfaceEntries)
    const locations = dedupeLocations([...scanLocations, ...managedLocations])

    if (repositoryEntry) {
      const cleanupAssessment = assessRepositoryCleanup(skillName, locations, repositoryEntry.path)
      issues.push(...cleanupAssessment.blockingIssues)
      cleanupWarnings.push(...cleanupAssessment.cleanupWarnings)
      cleanupActions.push(...cleanupAssessment.cleanupActions)
      continue
    }

    const assessment = assessLegacySources(skillName, locations)
    if (assessment.kind === 'migratable' && assessment.sourcePath && assessment.sourceSurfaceName) {
      items.push({
        skillName,
        sourcePath: assessment.sourcePath,
        sourceSurfaceName: assessment.sourceSurfaceName,
        repositoryPath: path.join(repositoryPath, skillName),
      })
      continue
    }

    issues.push(assessment.message)
  }

  const dedupedIssues = dedupeMessages(issues)
  const dedupedWarnings = dedupeMessages(cleanupWarnings)
  const dedupedCleanupActions = dedupeCleanupActions(cleanupActions)
  const canRun = (items.length > 0 || dedupedCleanupActions.length > 0) && dedupedIssues.length === 0

  return {
    needed: items.length > 0 || dedupedIssues.length > 0 || dedupedCleanupActions.length > 0,
    canRun,
    forceRequired: dedupedCleanupActions.length > 0,
    cleanupCount: dedupedCleanupActions.length,
    repositoryPath,
    items,
    issues: dedupedIssues,
    cleanupWarnings: dedupedWarnings,
    cleanupActions: dedupedCleanupActions,
  }
}

function canRemoveManagedEntries(entries: Array<RawEntry | undefined>): boolean {
  const existingEntries = entries.filter((entry): entry is RawEntry => Boolean(entry))
  return existingEntries.length > 0 && existingEntries.every((entry) => entry.kind === 'link')
}

function dedupeCleanupActions(actions: MigrationCleanupAction[]): MigrationCleanupAction[] {
  const seen = new Set<string>()
  const deduped: MigrationCleanupAction[] = []

  for (const action of actions) {
    const key = `${action.skillName}|${toComparisonKey(action.entryPath)}`
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(action)
  }

  return deduped
}

function dedupeSurfacePaths<TSurface extends Pick<ScanSurfaceDefinition, 'path'>>(surfaces: TSurface[]): TSurface[] {
  const seen = new Set<string>()
  const deduped: TSurface[] = []

  for (const surface of surfaces) {
    const key = toComparisonKey(surface.path)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(surface)
  }

  return deduped
}

function dedupeSkillNames(names: string[]): string[] {
  return [...new Set(names)]
}

function sameSurfacePathSet(left: ManagedSurfaceDefinition[], right: ManagedSurfaceDefinition[]): boolean {
  const leftPaths = uniquePaths(left.map((surface) => surface.path))
  const rightPaths = uniquePaths(right.map((surface) => surface.path))

  if (leftPaths.length !== rightPaths.length) {
    return false
  }

  return leftPaths.every((surfacePath) => rightPaths.some((otherPath) => samePath(surfacePath, otherPath)))
}

function hasManagedLinkDrift(
  repositoryPath: string,
  managedSurfaces: ManagedSurfaceDefinition[],
  currentEntries: Map<ManagedSurfaceDefinition['id'], RawEntry | null>,
): boolean {
  for (const surface of managedSurfaces) {
    const entry = currentEntries.get(surface.id)
    if (!entry) {
      return true
    }

    if (entry.kind !== 'link' || !entry.realPath || !samePath(entry.realPath, repositoryPath)) {
      return true
    }
  }

  return false
}

async function stageCleanupEntries(actions: MigrationCleanupAction[]): Promise<StagedCleanupEntry[]> {
  const stagedEntries: StagedCleanupEntry[] = []

  for (const action of actions) {
    const entry = await readEntry(path.basename(action.entryPath), action.entryPath)
    if (!entry) {
      continue
    }

    if (entry.kind === 'file') {
      throw new Error(`${action.skillName}: ${action.surfaceName} contains a file at ${entry.path}. Remove it manually first.`)
    }

    const tempPath = buildMigrationCleanupTempPath(path.dirname(entry.path), path.basename(entry.path))
    await fs.rename(entry.path, tempPath)
    stagedEntries.push({
      finalPath: entry.path,
      tempPath,
    })
  }

  return stagedEntries
}

async function readManagedEntries(
  skillName: string,
  managedSurfaces: ManagedSurfaceDefinition[],
): Promise<Map<ManagedSurfaceDefinition['id'], RawEntry | null>> {
  const entries = await Promise.all(
    managedSurfaces.map(async (surface) => [surface.id, await readEntry(skillName, path.join(surface.path, skillName))] as const),
  )

  return new Map(entries)
}

async function enableManagedSkill(
  skillName: string,
  repositoryPath: string,
  managedSurfaces: ManagedSurfaceDefinition[],
  currentEntries: Map<ManagedSurfaceDefinition['id'], RawEntry | null>,
): Promise<{ ok: boolean; message: string }> {
  const actions: Array<{ finalPath: string; tempPath: string; moved: boolean }> = []

  for (const surface of managedSurfaces) {
    const entry = currentEntries.get(surface.id)
    if (entry?.kind === 'link' && entry.realPath && samePath(entry.realPath, repositoryPath)) {
      continue
    }

    if (entry) {
      return {
        ok: false,
        message: `${surface.name} already has a conflicting entry for ${skillName}. Remove the conflict first.`,
      }
    }

    const finalPath = normalizeFsPath(path.join(surface.path, skillName))
    const tempPath = buildTempPath(surface.path, skillName, 'enable')
    actions.push({ finalPath, tempPath, moved: false })
  }

  if (!actions.length) {
    return {
      ok: managedSurfaces.length > 0,
      message: managedSurfaces.length > 0
        ? `${skillName} is already enabled across the configured managed outputs.`
        : `No managed outputs are configured for ${skillName}.`,
    }
  }

  const rollbackErrors: string[] = []

  try {
    for (const surface of managedSurfaces) {
      await fs.mkdir(surface.path, { recursive: true })
    }

    for (const action of actions) {
      await fs.symlink(repositoryPath, action.tempPath, 'junction')
    }

    for (const action of actions) {
      await fs.rename(action.tempPath, action.finalPath)
      action.moved = true
    }

    return {
      ok: true,
      message: `Enabled ${skillName} across ${managedSurfaces.length} managed output${managedSurfaces.length === 1 ? '' : 's'}.`,
    }
  } catch (error) {
    for (const action of [...actions].reverse()) {
      const rollbackPath = action.moved ? action.finalPath : action.tempPath
      if (await pathEntryExists(rollbackPath)) {
        await fs.rm(rollbackPath, { recursive: true, force: true, maxRetries: 3 }).catch((rollbackError) => {
          rollbackErrors.push(getErrorMessage(rollbackError))
        })
      }
    }

    return {
      ok: false,
      message: buildAtomicFailureMessage(`Failed to enable ${skillName}.`, error, rollbackErrors),
    }
  }
}

async function disableManagedSkill(
  skillName: string,
  repositoryPath: string,
  managedSurfaces: ManagedSurfaceDefinition[],
  currentEntries: Map<ManagedSurfaceDefinition['id'], RawEntry | null>,
): Promise<{ ok: boolean; message: string }> {
  const actions: Array<{ finalPath: string; tempPath: string; moved: boolean; deleted: boolean }> = []

  for (const surface of managedSurfaces) {
    const entry = currentEntries.get(surface.id)
    if (!entry) {
      continue
    }

    if (entry.kind !== 'link') {
      return {
        ok: false,
        message: `${surface.name} contains a real entry for ${skillName}. Refusing to remove it automatically.`,
      }
    }

    actions.push({
      finalPath: entry.path,
      tempPath: buildTempPath(surface.path, skillName, 'disable'),
      moved: false,
      deleted: false,
    })
  }

  if (!actions.length) {
    return {
      ok: true,
      message: managedSurfaces.length > 0
        ? `${skillName} is already disabled across the configured managed outputs.`
        : `No managed outputs are configured for ${skillName}.`,
    }
  }

  const rollbackErrors: string[] = []

  try {
    for (const action of actions) {
      await fs.rename(action.finalPath, action.tempPath)
      action.moved = true
    }

    for (const action of actions) {
      await fs.rm(action.tempPath, { recursive: true, force: true, maxRetries: 3 })
      action.deleted = true
    }

    return {
      ok: true,
      message: `Disabled ${skillName} across ${actions.length} managed output${actions.length === 1 ? '' : 's'}.`,
    }
  } catch (error) {
    for (const action of [...actions].reverse()) {
      if (!action.moved) {
        continue
      }

      if (action.deleted) {
        await fs.symlink(repositoryPath, action.finalPath, 'junction').catch((rollbackError) => {
          rollbackErrors.push(getErrorMessage(rollbackError))
        })
        continue
      }

      if (await pathEntryExists(action.tempPath)) {
        await fs.rename(action.tempPath, action.finalPath).catch((rollbackError) => {
          rollbackErrors.push(getErrorMessage(rollbackError))
        })
      }
    }

    return {
      ok: false,
      message: buildAtomicFailureMessage(`Failed to disable ${skillName}.`, error, rollbackErrors),
    }
  }
}

async function removeLegacyEntries(
  skillName: string,
  surfaces: Array<Pick<ScanSurfaceDefinition, 'path'>>,
): Promise<void> {
  for (const surface of surfaces) {
    const entryPath = path.join(surface.path, skillName)
    const entry = await readEntry(skillName, entryPath)
    if (!entry) {
      continue
    }

    if (entry.kind !== 'link') {
      continue
    }

    await fs.rm(entry.path, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function syncManagedOutputSelection(
  previousManagedSurfaces: ManagedSurfaceDefinition[],
  nextManagedSurfaces: ManagedSurfaceDefinition[],
  skills: SkillRow[],
): Promise<void> {
  if (sameSurfacePathSet(previousManagedSurfaces, nextManagedSurfaces)) {
    return
  }

  const removedSurfaces = previousManagedSurfaces.filter(
    (surface) => !nextManagedSurfaces.some((nextSurface) => samePath(nextSurface.path, surface.path)),
  )

  for (const skill of skills) {
    if (!skill.repositoryPath) {
      continue
    }

    if (removedSurfaces.length > 0) {
      await rollbackManagedLinks(skill.skillName, skill.repositoryPath, removedSurfaces)
    }

    if (skill.state !== 'enabled' || nextManagedSurfaces.length === 0) {
      continue
    }

    const currentEntries = await readManagedEntries(skill.skillName, nextManagedSurfaces)
    const enableResult = await enableManagedSkill(skill.skillName, skill.repositoryPath, nextManagedSurfaces, currentEntries)
    if (!enableResult.ok) {
      throw new Error(enableResult.message)
    }
  }
}

async function rollbackManagedLinks(
  skillName: string,
  repositoryPath: string,
  managedSurfaces: ManagedSurfaceDefinition[],
): Promise<void> {
  for (const surface of managedSurfaces) {
    const entry = await readEntry(skillName, path.join(surface.path, skillName))
    if (!entry || entry.kind !== 'link') {
      continue
    }

    if (!entry.realPath || samePath(entry.realPath, repositoryPath)) {
      await fs.rm(entry.path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
    }
  }
}

function buildTempPath(parentPath: string, skillName: string, action: 'enable' | 'disable'): string {
  return path.join(parentPath, `.${skillName}.skills-switch-${action}-${randomUUID()}`)
}

function buildMigrationCleanupTempPath(parentPath: string, entryName: string): string {
  return path.join(parentPath, `.${entryName}.skills-switch-migrate-cleanup-${randomUUID()}`)
}

function buildAtomicFailureMessage(prefix: string, error: unknown, rollbackErrors: string[]): string {
  if (!rollbackErrors.length) {
    return `${prefix} ${getErrorMessage(error)}`
  }

  return `${prefix} ${getErrorMessage(error)} Rollback also reported: ${rollbackErrors.join('; ')}`
}

function dedupeMessages(messages: string[]): string[] {
  return [...new Set(messages)]
}

async function scanDirectory(directoryPath: string, reservedNames: string[]): Promise<Map<string, RawEntry>> {
  try {
    const dirents = await fs.readdir(directoryPath, { withFileTypes: true })
    const entries = await Promise.all(
      dirents
        .filter((dirent) => !reservedNames.includes(dirent.name))
        .filter((dirent) => !dirent.name.startsWith('.'))
        .map((dirent) => readEntry(dirent.name, path.join(directoryPath, dirent.name))),
    )

    return new Map(entries.filter((entry): entry is RawEntry => Boolean(entry)).map((entry) => [entry.name, entry]))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return new Map()
    }

    throw error
  }
}

async function readEntry(name: string, entryPath: string): Promise<RawEntry | null> {
  try {
    const stats = await fs.lstat(entryPath)
    const kind: EntryKind = stats.isSymbolicLink() ? 'link' : stats.isDirectory() ? 'directory' : 'file'
    let targetPath: string | null = null
    let realPath: string | null = null

    if (kind === 'link') {
      try {
        const target = await fs.readlink(entryPath)
        targetPath = normalizeFsPath(path.isAbsolute(target) ? target : path.resolve(path.dirname(entryPath), target))
      } catch {
        targetPath = null
      }
    }

    if (kind !== 'file') {
      try {
        realPath = normalizeFsPath(await fs.realpath(entryPath))
      } catch {
        realPath = null
      }
    }

    return {
      name,
      path: normalizeFsPath(entryPath),
      kind,
      realPath,
      targetPath,
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Map<string, string>()
  for (const entryPath of paths) {
    seen.set(toComparisonKey(entryPath), entryPath)
  }

  return [...seen.values()]
}

async function pathExists(entryPath: string): Promise<boolean> {
  try {
    await fs.access(entryPath)
    return true
  } catch {
    return false
  }
}

async function pathEntryExists(entryPath: string): Promise<boolean> {
  try {
    await fs.lstat(entryPath)
    return true
  } catch {
    return false
  }
}

function normalizeFsPath(entryPath: string): string {
  let normalized = path.normalize(entryPath)

  if (normalized.startsWith('\\\\?\\')) {
    normalized = normalized.slice(4)
  }

  if (normalized.startsWith('\\??\\')) {
    normalized = normalized.slice(4)
  }

  return normalized
}

function samePath(left: string, right: string): boolean {
  return toComparisonKey(left) === toComparisonKey(right)
}

function toComparisonKey(entryPath: string): string {
  return normalizeFsPath(entryPath).toLowerCase()
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
