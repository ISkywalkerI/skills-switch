import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { HostDefinition } from '../shared/models.js'

interface CustomHostRecord {
  id: string
  name: string
  path: string
}

interface StoredConfig {
  repositoryPath: string
  customHosts: CustomHostRecord[]
}

export interface LoadedConfig extends StoredConfig {
  filePath: string
  hosts: HostDefinition[]
}

export function getDefaultRepositoryPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.skills-repo', 'skills')
}

export function getBuiltInHosts(homeDir = os.homedir()): HostDefinition[] {
  return [
    {
      id: 'opencode',
      name: 'OpenCode',
      kind: 'opencode',
      path: path.join(homeDir, '.agents', 'skills'),
      builtIn: true,
      reservedNames: [],
    },
    {
      id: 'claude',
      name: 'Claude Code',
      kind: 'claude',
      path: path.join(homeDir, '.claude', 'skills'),
      builtIn: true,
      reservedNames: [],
    },
    {
      id: 'codex',
      name: 'Codex',
      kind: 'codex',
      path: path.join(homeDir, '.codex', 'skills'),
      builtIn: true,
      reservedNames: ['.system'],
    },
  ]
}

export function createCustomHost(name: string, hostPath: string): CustomHostRecord {
  return {
    id: `custom-${randomUUID()}`,
    name,
    path: hostPath,
  }
}

export async function loadConfig(userDataPath: string): Promise<LoadedConfig> {
  const filePath = path.join(userDataPath, 'config.json')
  const stored = await readConfigFile(filePath)
  const repositoryPath = cleanPath(stored?.repositoryPath) ?? getDefaultRepositoryPath()
  const customHosts = normalizeCustomHosts(stored?.customHosts ?? [])

  return {
    filePath,
    repositoryPath,
    customHosts,
    hosts: [...getBuiltInHosts(), ...toCustomHostDefinitions(customHosts)],
  }
}

export async function saveConfig(config: LoadedConfig): Promise<void> {
  const payload: StoredConfig = {
    repositoryPath: config.repositoryPath,
    customHosts: config.customHosts,
  }

  await fs.mkdir(path.dirname(config.filePath), { recursive: true })
  await fs.writeFile(config.filePath, JSON.stringify(payload, null, 2), 'utf8')
}

function toCustomHostDefinitions(customHosts: CustomHostRecord[]): HostDefinition[] {
  return customHosts.map((host) => ({
    id: host.id,
    name: host.name,
    kind: 'custom',
    path: host.path,
    builtIn: false,
    reservedNames: [],
  }))
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

function normalizeCustomHosts(customHosts: CustomHostRecord[]): CustomHostRecord[] {
  return customHosts
    .map((host) => ({
      id: host.id,
      name: host.name.trim(),
      path: cleanPath(host.path) ?? '',
    }))
    .filter((host) => host.id && host.name && host.path)
}

function cleanPath(value: string | undefined | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? path.normalize(trimmed) : null
}
