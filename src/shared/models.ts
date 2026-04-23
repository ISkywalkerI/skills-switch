export type SkillState = 'enabled' | 'disabled' | 'partial' | 'invalid' | 'needsMigration' | 'conflict'

export type SkillEntryKind = 'link' | 'directory' | 'file'

export type ScanSurfaceId = string

export type ManagedSurfaceId = string

export type ThemeMode = 'dark' | 'light'

export interface AppSettings {
  theme: ThemeMode
  managedOutputPaths: string[]
  scannedPaths: string[]
}

export interface ScanSurfaceDefinition {
  id: ScanSurfaceId
  name: string
  path: string
  managed: boolean
  description: string
  reservedNames?: string[]
}

export interface ManagedSurfaceDefinition {
  id: ManagedSurfaceId
  name: string
  path: string
  role: 'primary' | 'compatibility'
  description: string
}

export interface ManagedLinkStatus {
  surfaceId: ManagedSurfaceId
  surfaceName: string
  entryPath: string
  state: 'enabled' | 'missing' | 'invalid'
  targetPath: string | null
  message: string
}

export interface SkillLocation {
  surfaceId: ScanSurfaceId
  surfaceName: string
  entryPath: string
  kind: SkillEntryKind
  targetPath: string | null
  realPath: string | null
}

export interface SkillRow {
  skillName: string
  state: SkillState
  repositoryPath: string | null
  canEnable: boolean
  canDisable: boolean
  message: string
  managedLinks: ManagedLinkStatus[]
  locations: SkillLocation[]
}

export interface MigrationPlanItem {
  skillName: string
  sourcePath: string
  sourceSurfaceName: string
  repositoryPath: string
}

export interface MigrationPreview {
  needed: boolean
  canRun: boolean
  forceRequired: boolean
  cleanupCount: number
  repositoryPath: string
  items: MigrationPlanItem[]
  issues: string[]
  cleanupWarnings: string[]
}

export interface AppSnapshot {
  repositoryPath: string
  repositoryExists: boolean
  settings: AppSettings
  settingsDefaults: AppSettings
  scanSurfaces: ScanSurfaceDefinition[]
  managedSurfaces: ManagedSurfaceDefinition[]
  skills: SkillRow[]
  migration: MigrationPreview
  lastUpdated: string
}

export interface BasicResponse {
  ok: boolean
  message: string
}

export interface SnapshotResponse extends BasicResponse {
  snapshot: AppSnapshot | null
}

export interface ToggleSkillRequest {
  skillName: string
  enabled: boolean
}

export interface RunMigrationRequest {
  forceCleanup?: boolean
}

export type SaveSettingsRequest = AppSettings

export interface UiApi {
  getSnapshot: () => Promise<AppSnapshot>
  toggleSkill: (request: ToggleSkillRequest) => Promise<SnapshotResponse>
  runMigration: (request?: RunMigrationRequest) => Promise<SnapshotResponse>
  saveSettings: (request: SaveSettingsRequest) => Promise<SnapshotResponse>
  openPath: (targetPath: string) => Promise<BasicResponse>
  minimizeWindow: () => Promise<void>
  toggleMaximizeWindow: () => Promise<boolean>
  closeWindow: () => Promise<void>
  isWindowMaximized: () => Promise<boolean>
}

export const SKILL_STATE_LABELS: Record<SkillState, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  partial: 'Partial',
  invalid: 'Conflict',
  needsMigration: 'Needs Migration',
  conflict: 'Conflict',
}
