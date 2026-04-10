import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import { getManagedSurfaces, getScanSurfaces, loadConfig } from './config.js'
import type {
  AppSnapshot,
  ManagedLinkStatus,
  ManagedSurfaceDefinition,
  MigrationPlanItem,
  MigrationPreview,
  ScanSurfaceDefinition,
  ScanSurfaceId,
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
  surfaceEntries: Map<ScanSurfaceId, Map<string, RawEntry>>
}

interface SourceAssessment {
  kind: 'migratable' | 'conflict' | 'invalid'
  message: string
  sourcePath: string | null
  sourceSurfaceName: string | null
}

export class SkillService {
  constructor(private readonly userDataPath: string) {}

  async getSnapshot(): Promise<AppSnapshot> {
    const config = await loadConfig(this.userDataPath)
    const scanSurfaces = getScanSurfaces()
    const managedSurfaces = getManagedSurfaces()
    const scanState = await scanStateForRepository(config.repositoryPath, scanSurfaces)
    const repositoryExists = await pathExists(config.repositoryPath)
    const migration = buildMigrationPreview(config.repositoryPath, scanSurfaces, scanState)

    const skillNames = new Set<string>(scanState.repositoryEntries.keys())
    for (const entries of scanState.surfaceEntries.values()) {
      for (const skillName of entries.keys()) {
        skillNames.add(skillName)
      }
    }

    const skills = [...skillNames]
      .map((skillName) => buildSkillRow(skillName, scanSurfaces, managedSurfaces, scanState))
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
      scanSurfaces,
      managedSurfaces,
      skills,
      migration,
      lastUpdated: new Date().toISOString(),
    }
  }

  async toggleSkill(request: ToggleSkillRequest): Promise<SnapshotResponse> {
    try {
      const config = await loadConfig(this.userDataPath)
      const managedSurfaces = getManagedSurfaces()
      const repositoryEntryPath = normalizeFsPath(path.join(config.repositoryPath, request.skillName))
      const repositoryEntry = await readEntry(request.skillName, repositoryEntryPath)

      if (!repositoryEntry || repositoryEntry.kind === 'file') {
        return this.buildResponse(false, `${request.skillName} is not present in the central repository. Run migration first.`)
      }

      const currentEntries = await readManagedEntries(request.skillName, managedSurfaces)
      const result = request.enabled
        ? await enableManagedSkill(request.skillName, repositoryEntryPath, managedSurfaces, currentEntries)
        : await disableManagedSkill(request.skillName, repositoryEntryPath, managedSurfaces, currentEntries)

      return this.buildResponse(result.ok, result.message)
    } catch (error) {
      return this.buildErrorResponse(getErrorMessage(error))
    }
  }

  async runMigration(): Promise<SnapshotResponse> {
    try {
      const config = await loadConfig(this.userDataPath)
      const scanSurfaces = getScanSurfaces()
      const managedSurfaces = getManagedSurfaces()
      const scanState = await scanStateForRepository(config.repositoryPath, scanSurfaces)
      const migration = buildMigrationPreview(config.repositoryPath, scanSurfaces, scanState)

      if (!migration.canRun) {
        return this.buildResponse(false, 'Migration is blocked. Resolve the listed issues first.')
      }

      if (!migration.items.length) {
        return this.buildResponse(true, 'Nothing needs to be migrated.')
      }

      await fs.mkdir(config.repositoryPath, { recursive: true })
      const movedItems: MigrationPlanItem[] = []
      const linkedSkills: MigrationPlanItem[] = []

      try {
        for (const item of migration.items) {
          await fs.rename(item.sourcePath, item.repositoryPath)
          movedItems.push(item)
        }

        for (const item of migration.items) {
          await removeLegacyEntries(item.skillName, scanSurfaces)
          const currentEntries = await readManagedEntries(item.skillName, managedSurfaces)
          const linkResult = await enableManagedSkill(item.skillName, item.repositoryPath, managedSurfaces, currentEntries)
          if (!linkResult.ok) {
            throw new Error(linkResult.message)
          }

          linkedSkills.push(item)
        }
      } catch (error) {
        for (const item of [...linkedSkills].reverse()) {
          await rollbackManagedLinks(item.skillName, item.repositoryPath, managedSurfaces)
        }

        for (const item of [...movedItems].reverse()) {
          if (await pathEntryExists(item.repositoryPath) && !(await pathEntryExists(item.sourcePath))) {
            await fs.rename(item.repositoryPath, item.sourcePath).catch(() => undefined)
          }
        }

        throw error
      }

      return this.buildResponse(true, `Migrated ${migration.items.length} skills into the central repository and synced managed links.`)
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

async function scanStateForRepository(repositoryPath: string, scanSurfaces: ScanSurfaceDefinition[]): Promise<ScanState> {
  const repositoryEntries = await scanDirectory(repositoryPath, [])
  const surfaceEntries = new Map<ScanSurfaceId, Map<string, RawEntry>>()

  const scannedEntries = await Promise.all(
    scanSurfaces.map(async (surface) => [surface.id, await scanDirectory(surface.path, getReservedNames(surface.id))] as const),
  )

  for (const [surfaceId, entries] of scannedEntries) {
    surfaceEntries.set(surfaceId, entries)
  }

  return {
    repositoryEntries,
    surfaceEntries,
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
  const locations = buildLocations(skillName, scanSurfaces, scanState.surfaceEntries)
  const managedLinks = managedSurfaces.map((surface) =>
    classifyManagedLink(skillName, surface, scanState.surfaceEntries.get(surface.id)?.get(skillName), repositoryPath),
  )
  const managedEntries = managedSurfaces.map((surface) => scanState.surfaceEntries.get(surface.id)?.get(skillName))
  const managedConflictMessages = repositoryEntry
    ? buildManagedConflictMessages(skillName, managedSurfaces, managedEntries, repositoryEntry.path)
    : []
  const legacyConflictMessages = repositoryEntry
    ? buildLegacyConflictMessages(skillName, locations, repositoryEntry.path)
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
    const enabledCount = managedLinks.filter((link) => link.state === 'enabled').length
    const missingCount = managedLinks.filter((link) => link.state === 'missing').length

    if (enabledCount === managedLinks.length) {
      return {
        skillName,
        state: 'enabled',
        repositoryPath,
        canEnable: false,
        canDisable: true,
        message: `${skillName} is linked into both managed surfaces.`,
        managedLinks,
        locations,
      }
    }

    if (missingCount === managedLinks.length) {
      return {
        skillName,
        state: 'disabled',
        repositoryPath,
        canEnable: true,
        canDisable: false,
        message: `${skillName} is stored centrally but currently disabled for all managed surfaces.`,
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
      message: `${skillName} is only linked into part of the managed surface set. Enable to repair both links, or disable to clear them.`,
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

function buildLocations(
  skillName: string,
  scanSurfaces: ScanSurfaceDefinition[],
  surfaceEntries: Map<ScanSurfaceId, Map<string, RawEntry>>,
): SkillLocation[] {
  return scanSurfaces.flatMap((surface) => {
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
    if (location.surfaceId === 'agents' || location.surfaceId === 'claude') {
      return []
    }

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

function buildMigrationPreview(
  repositoryPath: string,
  scanSurfaces: ScanSurfaceDefinition[],
  scanState: ScanState,
): MigrationPreview {
  const skillNames = new Set<string>()
  const items: MigrationPlanItem[] = []
  const issues: string[] = []

  for (const entries of scanState.surfaceEntries.values()) {
    for (const skillName of entries.keys()) {
      skillNames.add(skillName)
    }
  }

  for (const skillName of skillNames) {
    const repositoryEntry = scanState.repositoryEntries.get(skillName)
    const locations = buildLocations(skillName, scanSurfaces, scanState.surfaceEntries)

    if (repositoryEntry) {
      issues.push(...buildManagedConflictMessages(
        skillName,
        getManagedSurfaces(),
        getManagedSurfaces().map((surface) => scanState.surfaceEntries.get(surface.id)?.get(skillName)),
        repositoryEntry.path,
      ))
      issues.push(...buildLegacyConflictMessages(skillName, locations, repositoryEntry.path))
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

  return {
    needed: items.length > 0 || issues.length > 0,
    canRun: items.length > 0 && issues.length === 0,
    repositoryPath,
    items,
    issues: dedupeMessages(issues),
  }
}

function canRemoveManagedEntries(entries: Array<RawEntry | undefined>): boolean {
  const existingEntries = entries.filter((entry): entry is RawEntry => Boolean(entry))
  return existingEntries.length > 0 && existingEntries.every((entry) => entry.kind === 'link')
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
      ok: true,
      message: `${skillName} is already enabled in both managed surfaces.`,
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
      message: `Enabled ${skillName} in .agents and .claude.`,
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
      message: `${skillName} is already disabled in both managed surfaces.`,
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
      message: `Disabled ${skillName} in .agents and .claude.`,
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

async function removeLegacyEntries(skillName: string, scanSurfaces: ScanSurfaceDefinition[]): Promise<void> {
  for (const surface of scanSurfaces) {
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

function buildAtomicFailureMessage(prefix: string, error: unknown, rollbackErrors: string[]): string {
  if (!rollbackErrors.length) {
    return `${prefix} ${getErrorMessage(error)}`
  }

  return `${prefix} ${getErrorMessage(error)} Rollback also reported: ${rollbackErrors.join('; ')}`
}

function dedupeMessages(messages: string[]): string[] {
  return [...new Set(messages)]
}

function getReservedNames(surfaceId: ScanSurfaceId): string[] {
  return surfaceId === 'codex' ? ['.system'] : []
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
