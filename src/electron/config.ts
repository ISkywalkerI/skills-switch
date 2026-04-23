import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { AppSettings, ManagedSurfaceDefinition, ScanSurfaceDefinition, ThemeMode } from '../shared/models.js'

interface StoredConfig {
  repositoryPath?: string
  theme?: ThemeMode
  managedOutputPaths?: string[]
  scannedPaths?: string[]
}

export interface LoadedConfig {
  filePath: string
  repositoryPath: string
  settings: AppSettings
  settingsDefaults: AppSettings
  managedSurfaces: ManagedSurfaceDefinition[]
  scanSurfaces: ScanSurfaceDefinition[]
}

const DEFAULT_THEME: ThemeMode = 'dark'

export function getDefaultRepositoryPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.skills-repo', 'skills')
}

export function getDefaultSettings(homeDir = os.homedir()): AppSettings {
  return {
    theme: DEFAULT_THEME,
    managedOutputPaths: getDefaultManagedSurfaceTemplates(homeDir).map((surface) => surface.path),
    scannedPaths: getDefaultScanSurfaceTemplates(homeDir).map((surface) => surface.path),
  }
}

export function getScanSurfaces(settings: AppSettings, homeDir = os.homedir()): ScanSurfaceDefinition[] {
  const defaultSurfaces = getDefaultScanSurfaceTemplates(homeDir)
  const managedPaths = new Set(settings.managedOutputPaths.map((surfacePath) => toComparisonKey(surfacePath)))

  return settings.scannedPaths.map((surfacePath, index) => {
    const defaultSurface = defaultSurfaces.find((surface) => samePath(surface.path, surfacePath))
    const managed = managedPaths.has(toComparisonKey(surfacePath))

    return {
      id: defaultSurface?.id ?? `scan-${index + 1}`,
      name: defaultSurface?.name ?? `Scanned path ${index + 1}`,
      path: surfacePath,
      managed,
      description: defaultSurface?.description ?? (managed
        ? 'Custom path used for both discovery and managed output syncing.'
        : 'Custom path scanned for skills.'),
      reservedNames: defaultSurface?.reservedNames ?? [],
    }
  })
}

export function getManagedSurfaces(settings: AppSettings, homeDir = os.homedir()): ManagedSurfaceDefinition[] {
  const defaultSurfaces = getDefaultManagedSurfaceTemplates(homeDir)

  return settings.managedOutputPaths.map((surfacePath, index) => {
    const defaultSurface = defaultSurfaces.find((surface) => samePath(surface.path, surfacePath))

    return {
      id: defaultSurface?.id ?? `managed-${index + 1}`,
      name: defaultSurface?.name ?? `Managed output ${index + 1}`,
      path: surfacePath,
      role: index === 0 ? 'primary' : 'compatibility',
      description: defaultSurface?.description ?? (index === 0
        ? 'Primary managed output configured in settings.'
        : 'Additional managed output configured in settings.'),
    }
  })
}

export function normalizeSettingsForSave(settings: AppSettings): AppSettings {
  return {
    theme: normalizeTheme(settings.theme),
    managedOutputPaths: normalizePathList(settings.managedOutputPaths, 'Managed outputs'),
    scannedPaths: normalizePathList(settings.scannedPaths, 'Scanned paths'),
  }
}

function getDefaultScanSurfaceTemplates(homeDir = os.homedir()): ScanSurfaceDefinition[] {
  return [
    {
      id: 'opencode',
      name: 'OpenCode legacy scan',
      path: path.join(homeDir, '.opencode', 'skills'),
      managed: false,
      description: 'Scanned for legacy OpenCode skills only. This path is no longer managed.',
      reservedNames: [],
    },
    {
      id: 'opencodeConfig',
      name: 'OpenCode config scan',
      path: path.join(homeDir, '.config', 'opencode', 'skills'),
      managed: false,
      description: 'Scanned for OpenCode skills under the .config layout.',
      reservedNames: [],
    },
    {
      id: 'claude',
      name: 'Claude compatibility surface',
      path: path.join(homeDir, '.claude', 'skills'),
      managed: true,
      description: 'Managed compatibility layer for Claude.',
      reservedNames: [],
    },
    {
      id: 'agents',
      name: '.agents primary surface',
      path: path.join(homeDir, '.agents', 'skills'),
      managed: true,
      description: 'Primary managed surface used by OpenCode and Codex.',
      reservedNames: [],
    },
    {
      id: 'codex',
      name: 'Codex legacy scan',
      path: path.join(homeDir, '.codex', 'skills'),
      managed: false,
      description: 'Scanned for legacy Codex skills only. This path is no longer managed.',
      reservedNames: ['.system'],
    },
  ]
}

function getDefaultManagedSurfaceTemplates(homeDir = os.homedir()): ManagedSurfaceDefinition[] {
  return [
    {
      id: 'agents',
      name: '.agents primary surface',
      path: path.join(homeDir, '.agents', 'skills'),
      role: 'primary',
      description: 'Primary managed surface shared by OpenCode and Codex.',
    },
    {
      id: 'claude',
      name: 'Claude compatibility surface',
      path: path.join(homeDir, '.claude', 'skills'),
      role: 'compatibility',
      description: 'Compatibility layer that keeps Claude aligned with the primary surface.',
    },
  ]
}

export async function loadConfig(userDataPath: string): Promise<LoadedConfig> {
  const filePath = path.join(userDataPath, 'config.json')
  const stored = await readConfigFile(filePath)
  const settingsDefaults = getDefaultSettings()
  const settings = loadStoredSettings(stored, settingsDefaults)

  return {
    filePath,
    repositoryPath: cleanPath(stored?.repositoryPath) ?? getDefaultRepositoryPath(),
    settings,
    settingsDefaults,
    managedSurfaces: getManagedSurfaces(settings),
    scanSurfaces: getScanSurfaces(settings),
  }
}

export async function saveConfig(config: LoadedConfig): Promise<void> {
  const payload: StoredConfig = {
    repositoryPath: config.repositoryPath,
    theme: config.settings.theme,
    managedOutputPaths: config.settings.managedOutputPaths,
    scannedPaths: config.settings.scannedPaths,
  }

  await fs.mkdir(path.dirname(config.filePath), { recursive: true })
  await fs.writeFile(config.filePath, JSON.stringify(payload, null, 2), 'utf8')
}

function loadStoredSettings(stored: StoredConfig | null, defaults: AppSettings): AppSettings {
  return {
    theme: normalizeTheme(stored?.theme),
    managedOutputPaths: loadPathList(stored?.managedOutputPaths, defaults.managedOutputPaths),
    scannedPaths: loadPathList(stored?.scannedPaths, defaults.scannedPaths),
  }
}

async function readConfigFile(filePath: string): Promise<StoredConfig | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    return JSON.parse(content) as StoredConfig
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      return null
    }

    throw error
  }
}

function cleanPath(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? normalizeComparablePath(trimmed) : null
}

function loadPathList(storedPaths: string[] | undefined | null, fallbackPaths: string[]): string[] {
  if (storedPaths === undefined) {
    return [...fallbackPaths]
  }

  if (storedPaths === null) {
    return []
  }

  return dedupePaths(
    storedPaths
      .map((entryPath) => cleanPath(entryPath))
      .filter((entryPath): entryPath is string => Boolean(entryPath)),
  )
}

function normalizePathList(paths: string[], label: string): string[] {
  const normalizedPaths = paths.map((entryPath) => cleanPath(entryPath))
  const emptyIndex = normalizedPaths.findIndex((entryPath) => !entryPath)

  if (emptyIndex !== -1) {
    throw new Error(`${label} cannot contain empty paths.`)
  }

  const dedupedPaths = dedupePaths(normalizedPaths as string[])
  if (dedupedPaths.length !== normalizedPaths.length) {
    throw new Error(`${label} cannot contain duplicate paths.`)
  }

  return dedupedPaths
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>()
  const deduped: string[] = []

  for (const entryPath of paths) {
    const key = toComparisonKey(entryPath)
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    deduped.push(entryPath)
  }

  return deduped
}

function normalizeTheme(theme: ThemeMode | undefined): ThemeMode {
  return theme === 'light' ? 'light' : DEFAULT_THEME
}

function samePath(left: string, right: string): boolean {
  return toComparisonKey(left) === toComparisonKey(right)
}

function toComparisonKey(entryPath: string): string {
  return normalizeComparablePath(entryPath).toLowerCase()
}

function normalizeComparablePath(entryPath: string): string {
  let normalized = path.normalize(entryPath)
  const root = path.parse(normalized).root

  while (normalized.length > root.length && /[\\/]$/.test(normalized)) {
    normalized = normalized.slice(0, -1)
  }

  return normalized
}
