import { promises as fs } from 'node:fs'
import path from 'node:path'

import { createCustomHost, loadConfig, saveConfig } from './config.js'
import type {
  AddCustomHostRequest,
  AppSnapshot,
  HostDefinition,
  HostSummary,
  MigrationPlanItem,
  MigrationPreview,
  SkillCell,
  SkillRow,
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

export class SkillService {
  constructor(private readonly userDataPath: string) {}

  async getSnapshot(): Promise<AppSnapshot> {
    const config = await loadConfig(this.userDataPath)
    const repositoryExists = await pathExists(config.repositoryPath)
    const repositoryEntries = await scanDirectory(config.repositoryPath, [])
    const hostEntriesByHost = new Map<string, Map<string, RawEntry>>()

    for (const host of config.hosts) {
      hostEntriesByHost.set(host.id, await scanDirectory(host.path, host.reservedNames))
    }

    const skillNames = new Set<string>(repositoryEntries.keys())
    for (const entries of hostEntriesByHost.values()) {
      for (const skillName of entries.keys()) {
        skillNames.add(skillName)
      }
    }

    const skills = [...skillNames]
      .sort((left, right) => left.localeCompare(right))
      .map((skillName) => {
        const repositoryEntry = repositoryEntries.get(skillName)
        const row: SkillRow = {
          skillName,
          inRepository: Boolean(repositoryEntry),
          repositoryPath: repositoryEntry?.path ?? null,
          hosts: {},
        }

        for (const host of config.hosts) {
          const entry = hostEntriesByHost.get(host.id)?.get(skillName)
          row.hosts[host.id] = classifyCell(host, skillName, entry, repositoryEntry)
        }

        return row
      })
      .sort((left, right) => {
        if (left.inRepository !== right.inRepository) {
          return left.inRepository ? -1 : 1
        }

        return left.skillName.localeCompare(right.skillName)
      })

    return {
      repositoryPath: config.repositoryPath,
      repositoryExists,
      hosts: config.hosts,
      hostSummaries: buildHostSummaries(config.hosts, skills),
      skills,
      migration: buildMigrationPreview(config.repositoryPath, config.hosts, repositoryEntries, hostEntriesByHost),
      lastUpdated: new Date().toISOString(),
    }
  }

  async addCustomHost(request: AddCustomHostRequest): Promise<SnapshotResponse> {
    try {
      const name = request.name.trim()
      const hostPath = normalizeFsPath(request.path)

      if (!name) {
        return this.buildResponse(false, 'Custom host name is required.')
      }

      const config = await loadConfig(this.userDataPath)
      if (config.hosts.some((host) => samePath(host.path, hostPath))) {
        return this.buildResponse(false, `A host already points to ${hostPath}.`)
      }

      config.customHosts.push(createCustomHost(name, hostPath))
      config.hosts = [...config.hosts, {
        id: config.customHosts.at(-1)!.id,
        name,
        kind: 'custom',
        path: hostPath,
        builtIn: false,
        reservedNames: [],
      }]

      await saveConfig(config)
      return this.buildResponse(true, `Added custom host ${name}.`)
    } catch (error) {
      return this.buildResponse(false, getErrorMessage(error))
    }
  }

  async removeCustomHost(hostId: string): Promise<SnapshotResponse> {
    try {
      const config = await loadConfig(this.userDataPath)
      const host = config.hosts.find((entry) => entry.id === hostId)

      if (!host) {
        return this.buildResponse(false, 'Host was not found.')
      }

      if (host.builtIn) {
        return this.buildResponse(false, 'Built-in hosts cannot be removed.')
      }

      config.customHosts = config.customHosts.filter((entry) => entry.id !== hostId)
      config.hosts = config.hosts.filter((entry) => entry.id !== hostId)
      await saveConfig(config)

      return this.buildResponse(true, `Removed custom host ${host.name}.`)
    } catch (error) {
      return this.buildResponse(false, getErrorMessage(error))
    }
  }

  async toggleSkill(request: ToggleSkillRequest): Promise<SnapshotResponse> {
    try {
      const config = await loadConfig(this.userDataPath)
      const host = config.hosts.find((entry) => entry.id === request.hostId)

      if (!host) {
        return this.buildResponse(false, 'Host was not found.')
      }

      if (host.reservedNames.includes(request.skillName)) {
        return this.buildResponse(false, `${request.skillName} is reserved for ${host.name}.`)
      }

      const entryPath = path.join(host.path, request.skillName)
      const currentEntry = await readEntry(request.skillName, entryPath)
      const repositoryEntryPath = path.join(config.repositoryPath, request.skillName)
      const hasRepositorySkill = await pathExists(repositoryEntryPath)

      if (request.enabled) {
        if (!hasRepositorySkill) {
          return this.buildResponse(false, `${request.skillName} is not present in the central repository.`)
        }

        if (currentEntry) {
          if (
            currentEntry.kind === 'link' &&
            currentEntry.realPath &&
            samePath(currentEntry.realPath, repositoryEntryPath)
          ) {
            return this.buildResponse(true, `${request.skillName} is already enabled for ${host.name}.`)
          }

          return this.buildResponse(
            false,
            `${host.name} already has a conflicting entry for ${request.skillName}. Migrate or clean it first.`,
          )
        }

        await fs.mkdir(host.path, { recursive: true })
        await fs.symlink(repositoryEntryPath, entryPath, 'junction')

        return this.buildResponse(true, `Enabled ${request.skillName} for ${host.name}.`)
      }

      if (!currentEntry) {
        return this.buildResponse(true, `${request.skillName} is already disabled for ${host.name}.`)
      }

      if (currentEntry.kind !== 'link') {
        return this.buildResponse(
          false,
          `${host.name} contains a real directory for ${request.skillName}. Refusing to remove it automatically.`,
        )
      }

      await fs.rm(entryPath, { recursive: true, force: true, maxRetries: 3 })
      return this.buildResponse(true, `Disabled ${request.skillName} for ${host.name}.`)
    } catch (error) {
      return this.buildResponse(false, getErrorMessage(error))
    }
  }

  async runMigration(): Promise<SnapshotResponse> {
    try {
      const config = await loadConfig(this.userDataPath)
      const repositoryEntries = await scanDirectory(config.repositoryPath, [])
      const hostEntriesByHost = new Map<string, Map<string, RawEntry>>()

      for (const host of config.hosts) {
        hostEntriesByHost.set(host.id, await scanDirectory(host.path, host.reservedNames))
      }

      const migration = buildMigrationPreview(config.repositoryPath, config.hosts, repositoryEntries, hostEntriesByHost)
      if (!migration.canRun) {
        return this.buildResponse(false, 'Migration is blocked. Resolve the listed issues first.')
      }

      if (!migration.items.length) {
        return this.buildResponse(true, 'Nothing needs to be migrated.')
      }

      await fs.mkdir(config.repositoryPath, { recursive: true })

      for (const item of migration.items) {
        const targetExists = await pathExists(item.repositoryPath)
        if (!targetExists) {
          await fs.rename(item.sourcePath, item.repositoryPath)
        }
      }

      for (const item of migration.items) {
        for (const hostId of item.hostIds) {
          const host = config.hosts.find((entry) => entry.id === hostId)
          if (!host) {
            continue
          }

          const entryPath = path.join(host.path, item.skillName)
          if (await pathExists(entryPath)) {
            await fs.rm(entryPath, { recursive: true, force: true, maxRetries: 3 })
          }

          await fs.mkdir(host.path, { recursive: true })
          await fs.symlink(item.repositoryPath, entryPath, 'junction')
        }
      }

      return this.buildResponse(true, `Migrated ${migration.items.length} skills into the central repository.`)
    } catch (error) {
      return this.buildResponse(false, getErrorMessage(error))
    }
  }

  private async buildResponse(ok: boolean, message: string): Promise<SnapshotResponse> {
    return {
      ok,
      message,
      snapshot: await this.getSnapshot(),
    }
  }
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

function classifyCell(
  host: HostDefinition,
  skillName: string,
  entry: RawEntry | undefined,
  repositoryEntry: RawEntry | undefined,
): SkillCell {
  const repositoryPath = repositoryEntry?.path ?? null

  if (!entry) {
    return {
      skillName,
      hostId: host.id,
      state: repositoryEntry ? 'disabled' : 'unavailable',
      canEnable: Boolean(repositoryEntry),
      canDisable: false,
      entryPath: null,
      targetPath: repositoryPath,
      message: repositoryEntry
        ? `${skillName} is available in the repository but not linked into ${host.name}.`
        : `${skillName} is not available for ${host.name} until it is migrated into the repository.`,
    }
  }

  if (entry.kind === 'directory') {
    return {
      skillName,
      hostId: host.id,
      state: 'invalid',
      canEnable: false,
      canDisable: false,
      entryPath: entry.path,
      targetPath: entry.realPath,
      message: `${host.name} contains a real directory for ${skillName}. Use the migration flow to convert it into a managed link.`,
    }
  }

  if (entry.kind === 'file') {
    return {
      skillName,
      hostId: host.id,
      state: 'invalid',
      canEnable: false,
      canDisable: false,
      entryPath: entry.path,
      targetPath: null,
      message: `${host.name} contains a file named ${skillName}. Skills must be directories or junctions.`,
    }
  }

  if (!entry.realPath) {
    return {
      skillName,
      hostId: host.id,
      state: 'orphaned',
      canEnable: false,
      canDisable: true,
      entryPath: entry.path,
      targetPath: entry.targetPath,
      message: `${host.name} has a broken link for ${skillName}. Disable it to remove the broken junction.`,
    }
  }

  if (!repositoryEntry) {
    return {
      skillName,
      hostId: host.id,
      state: 'orphaned',
      canEnable: false,
      canDisable: true,
      entryPath: entry.path,
      targetPath: entry.realPath,
      message: `${skillName} points to ${entry.realPath}, but there is no central repository copy yet. Run migration first.`,
    }
  }

  if (samePath(entry.realPath, repositoryEntry.path)) {
    return {
      skillName,
      hostId: host.id,
      state: 'enabled',
      canEnable: false,
      canDisable: true,
      entryPath: entry.path,
      targetPath: entry.realPath,
      message: `${skillName} is linked into ${host.name}.`,
    }
  }

  return {
    skillName,
    hostId: host.id,
    state: 'invalid',
    canEnable: false,
    canDisable: true,
    entryPath: entry.path,
    targetPath: entry.realPath,
    message: `${skillName} is linked to ${entry.realPath} instead of the central repository. Disable it first, then enable the managed link.`,
  }
}

function buildHostSummaries(hosts: HostDefinition[], skills: SkillRow[]): Record<string, HostSummary> {
  const summaries = Object.fromEntries(
    hosts.map((host) => [
      host.id,
      {
        enabled: 0,
        disabled: 0,
        issues: 0,
      },
    ]),
  ) as Record<string, HostSummary>

  for (const skill of skills) {
    for (const host of hosts) {
      const cell = skill.hosts[host.id]
      if (cell.state === 'enabled') {
        summaries[host.id].enabled += 1
      } else if (cell.state === 'disabled') {
        summaries[host.id].disabled += 1
      } else if (cell.state === 'invalid' || cell.state === 'orphaned') {
        summaries[host.id].issues += 1
      }
    }
  }

  return summaries
}

function buildMigrationPreview(
  repositoryPath: string,
  hosts: HostDefinition[],
  repositoryEntries: Map<string, RawEntry>,
  hostEntriesByHost: Map<string, Map<string, RawEntry>>,
): MigrationPreview {
  const items: MigrationPlanItem[] = []
  const issues: string[] = []
  const skillNames = new Set<string>()

  for (const entries of hostEntriesByHost.values()) {
    for (const skillName of entries.keys()) {
      skillNames.add(skillName)
    }
  }

  for (const skillName of skillNames) {
    const repositoryEntry = repositoryEntries.get(skillName)
    const hostEntries = hosts
      .map((host) => ({ host, entry: hostEntriesByHost.get(host.id)?.get(skillName) }))
      .filter((item): item is { host: HostDefinition; entry: RawEntry } => Boolean(item.entry))

    if (!hostEntries.length) {
      continue
    }

    if (repositoryEntry) {
      for (const item of hostEntries) {
        if (item.entry.kind === 'file') {
          issues.push(`${skillName}: ${item.host.name} contains a file instead of a skill directory.`)
          continue
        }

        if (!item.entry.realPath) {
          issues.push(`${skillName}: ${item.host.name} has a broken link that must be removed manually or disabled.`)
          continue
        }

        if (!samePath(item.entry.realPath, repositoryEntry.path)) {
          issues.push(
            `${skillName}: ${item.host.name} points at ${item.entry.realPath}, but the repository already contains ${repositoryEntry.path}.`,
          )
        }
      }

      continue
    }

    const usableEntries = hostEntries.filter((item) => item.entry.kind !== 'file' && item.entry.realPath)
    if (!usableEntries.length) {
      issues.push(`${skillName}: no usable source directory was found for migration.`)
      continue
    }

    const uniqueSources = uniquePaths(usableEntries.map((item) => item.entry.realPath!))
    if (uniqueSources.length > 1) {
      issues.push(`${skillName}: multiple different source directories were detected: ${uniqueSources.join(', ')}`)
      continue
    }

    items.push({
      skillName,
      sourcePath: uniqueSources[0],
      repositoryPath: path.join(repositoryPath, skillName),
      hostIds: usableEntries.map((item) => item.host.id),
      hostNames: usableEntries.map((item) => item.host.name),
    })
  }

  return {
    needed: items.length > 0 || issues.length > 0,
    canRun: items.length > 0 && issues.length === 0,
    repositoryPath,
    items,
    issues,
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
