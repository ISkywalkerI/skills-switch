import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { ManagedSurfaceDefinition, ScanSurfaceDefinition } from '../shared/models.js'

interface StoredConfig {
  repositoryPath?: string
}

export interface LoadedConfig {
  filePath: string
  repositoryPath: string
}

export function getDefaultRepositoryPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.skills-repo', 'skills')
}

export function getScanSurfaces(homeDir = os.homedir()): ScanSurfaceDefinition[] {
  return [
    {
      id: 'opencode',
      name: 'OpenCode legacy scan',
      path: path.join(homeDir, '.opencode', 'skills'),
      managed: false,
      description: 'Scanned for legacy OpenCode skills only. This path is no longer managed.',
    },
    {
      id: 'claude',
      name: 'Claude compatibility surface',
      path: path.join(homeDir, '.claude', 'skills'),
      managed: true,
      description: 'Managed compatibility layer for Claude.',
    },
    {
      id: 'agents',
      name: '.agents primary surface',
      path: path.join(homeDir, '.agents', 'skills'),
      managed: true,
      description: 'Primary managed surface used by OpenCode and Codex.',
    },
    {
      id: 'codex',
      name: 'Codex legacy scan',
      path: path.join(homeDir, '.codex', 'skills'),
      managed: false,
      description: 'Scanned for legacy Codex skills only. This path is no longer managed.',
    },
  ]
}

export function getManagedSurfaces(homeDir = os.homedir()): ManagedSurfaceDefinition[] {
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

  return {
    filePath,
    repositoryPath: cleanPath(stored?.repositoryPath) ?? getDefaultRepositoryPath(),
  }
}

export async function saveConfig(config: LoadedConfig): Promise<void> {
  const payload: StoredConfig = {
    repositoryPath: config.repositoryPath,
  }

  await fs.mkdir(path.dirname(config.filePath), { recursive: true })
  await fs.writeFile(config.filePath, JSON.stringify(payload, null, 2), 'utf8')
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
  return trimmed ? path.normalize(trimmed) : null
}
