export type CellState = 'enabled' | 'disabled' | 'invalid' | 'orphaned' | 'unavailable'

export type HostKind = 'opencode' | 'claude' | 'codex' | 'custom'

export interface HostDefinition {
  id: string
  name: string
  kind: HostKind
  path: string
  builtIn: boolean
  reservedNames: string[]
}

export interface HostSummary {
  enabled: number
  disabled: number
  issues: number
}

export interface SkillCell {
  skillName: string
  hostId: string
  state: CellState
  canEnable: boolean
  canDisable: boolean
  entryPath: string | null
  targetPath: string | null
  message: string
}

export interface SkillRow {
  skillName: string
  inRepository: boolean
  repositoryPath: string | null
  hosts: Record<string, SkillCell>
}

export interface MigrationPlanItem {
  skillName: string
  sourcePath: string
  repositoryPath: string
  hostIds: string[]
  hostNames: string[]
}

export interface MigrationPreview {
  needed: boolean
  canRun: boolean
  repositoryPath: string
  items: MigrationPlanItem[]
  issues: string[]
}

export interface AppSnapshot {
  repositoryPath: string
  repositoryExists: boolean
  hosts: HostDefinition[]
  hostSummaries: Record<string, HostSummary>
  skills: SkillRow[]
  migration: MigrationPreview
  lastUpdated: string
}

export interface BasicResponse {
  ok: boolean
  message: string
}

export interface SnapshotResponse extends BasicResponse {
  snapshot: AppSnapshot
}

export interface ToggleSkillRequest {
  hostId: string
  skillName: string
  enabled: boolean
}

export interface AddCustomHostRequest {
  name: string
  path: string
}

export interface UiApi {
  getSnapshot: () => Promise<AppSnapshot>
  toggleSkill: (request: ToggleSkillRequest) => Promise<SnapshotResponse>
  addCustomHost: (request: AddCustomHostRequest) => Promise<SnapshotResponse>
  removeCustomHost: (hostId: string) => Promise<SnapshotResponse>
  runMigration: () => Promise<SnapshotResponse>
  chooseDirectory: () => Promise<string | null>
  openPath: (targetPath: string) => Promise<BasicResponse>
}

export const CELL_STATE_LABELS: Record<CellState, string> = {
  enabled: 'Linked',
  disabled: 'Off',
  invalid: 'Conflict',
  orphaned: 'Orphaned',
  unavailable: 'Unavailable',
}
