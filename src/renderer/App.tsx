import { useEffect, useState } from 'react'

import { SKILL_STATE_LABELS } from '../shared/models'
import type { AppSettings, AppSnapshot, SkillRow, ThemeMode } from '../shared/models'
import appIconUrl from '../../assets/icons/icon.png'

type Feedback = {
  tone: 'success' | 'error'
  text: string
}

type ViewMode = 'dashboard' | 'settings'
type PathListKey = 'managedOutputPaths' | 'scannedPaths'

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null)
  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('dashboard')
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    void refreshSnapshot(true)

    const handleResize = () => {
      void syncWindowState()
    }

    void syncWindowState()
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    const activeTheme = viewMode === 'settings' && settingsDraft ? settingsDraft.theme : snapshot?.settings.theme ?? 'dark'
    document.documentElement.dataset.theme = activeTheme
  }, [settingsDraft, snapshot, viewMode])

  async function refreshSnapshot(clearFeedback = false): Promise<void> {
    try {
      setBusyToken('refresh')
      const nextSnapshot = await window.skillsSwitch.getSnapshot()
      setSnapshot(nextSnapshot)
      setSettingsDraft((current) => current ?? cloneSettings(nextSnapshot.settings))
      if (clearFeedback) {
        setFeedback(null)
      }
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: getErrorMessage(error),
      })
    } finally {
      setBusyToken(null)
    }
  }

  async function handleToggle(skillName: string, enabled: boolean): Promise<void> {
    setBusyToken(`toggle:${skillName}`)

    try {
      const result = await window.skillsSwitch.toggleSkill({ skillName, enabled })
      if (result.snapshot) {
        setSnapshot(result.snapshot)
      }
      setFeedback({
        tone: result.ok ? 'success' : 'error',
        text: result.message,
      })
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: getErrorMessage(error),
      })
    } finally {
      setBusyToken(null)
    }
  }

  async function handleSaveSettings(): Promise<void> {
    if (!settingsDraft) {
      return
    }

    setBusyToken('saveSettings')

    try {
      const result = await window.skillsSwitch.saveSettings(settingsDraft)
      if (result.snapshot) {
        setSnapshot(result.snapshot)
        setSettingsDraft(cloneSettings(result.snapshot.settings))
      }
      setFeedback({
        tone: result.ok ? 'success' : 'error',
        text: result.message,
      })
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: getErrorMessage(error),
      })
    } finally {
      setBusyToken(null)
    }
  }

  function handleDiscardSettings(): void {
    if (!snapshot) {
      return
    }

    setSettingsDraft(cloneSettings(snapshot.settings))
  }

  function handleThemeChange(theme: ThemeMode): void {
    setSettingsDraft((current) => current ? { ...current, theme } : current)
  }

  function handleAddPath(listKey: PathListKey): void {
    setSettingsDraft((current) => {
      if (!current) {
        return current
      }

      return {
        ...current,
        [listKey]: [...current[listKey], ''],
      }
    })
  }

  function handlePathChange(listKey: PathListKey, index: number, value: string): void {
    setSettingsDraft((current) => {
      if (!current) {
        return current
      }

      const nextPaths = [...current[listKey]]
      nextPaths[index] = value
      return {
        ...current,
        [listKey]: nextPaths,
      }
    })
  }

  function handleRemovePath(listKey: PathListKey, index: number): void {
    setSettingsDraft((current) => {
      if (!current) {
        return current
      }

      return {
        ...current,
        [listKey]: current[listKey].filter((_entryPath, entryIndex) => entryIndex !== index),
      }
    })
  }

  function handleResetPathList(listKey: PathListKey): void {
    if (!snapshot) {
      return
    }

    setSettingsDraft((current) => {
      if (!current) {
        return current
      }

      return {
        ...current,
        [listKey]: [...snapshot.settingsDefaults[listKey]],
      }
    })
  }

  async function handleMigration(): Promise<void> {
    if (!snapshot) {
      return
    }

    const forceCleanup = snapshot.migration.forceRequired
    if (forceCleanup) {
      const confirmed = window.confirm(
        `This migration will remove ${snapshot.migration.cleanupCount} conflicting filesystem entries and then sync everything to the central repository. Continue?`,
      )

      if (!confirmed) {
        setFeedback({
          tone: 'error',
          text: 'Migration cancelled by user.',
        })
        return
      }
    }

    try {
      setBusyToken('migrate')
      const result = await window.skillsSwitch.runMigration({ forceCleanup })
      if (result.snapshot) {
        setSnapshot(result.snapshot)
      }
      setFeedback({
        tone: result.ok ? 'success' : 'error',
        text: result.message,
      })
    } catch (error) {
      setFeedback({
        tone: 'error',
        text: getErrorMessage(error),
      })
    } finally {
      setBusyToken(null)
    }
  }

  async function handleOpenPath(targetPath: string): Promise<void> {
    const result = await window.skillsSwitch.openPath(targetPath)
    setFeedback({
      tone: result.ok ? 'success' : 'error',
      text: result.message,
    })
  }

  async function syncWindowState(): Promise<void> {
    try {
      const maximized = await window.skillsSwitch.isWindowMaximized()
      setIsMaximized(maximized)
    } catch {
      setIsMaximized(false)
    }
  }

  async function handleMinimizeWindow(): Promise<void> {
    await window.skillsSwitch.minimizeWindow()
  }

  async function handleToggleMaximizeWindow(): Promise<void> {
    const maximized = await window.skillsSwitch.toggleMaximizeWindow()
    setIsMaximized(maximized)
  }

  async function handleCloseWindow(): Promise<void> {
    await window.skillsSwitch.closeWindow()
  }

  const isBusy = busyToken !== null
  const enabledCount = snapshot?.skills.filter((skill) => skill.state === 'enabled').length ?? 0
  const migrationCount = snapshot?.skills.filter((skill) => skill.state === 'needsMigration').length ?? 0
  const issueCount = snapshot?.skills.filter((skill) => skill.state === 'invalid' || skill.state === 'conflict' || skill.state === 'partial').length ?? 0
  const hasUnsavedSettings = snapshot && settingsDraft ? !areSettingsEqual(snapshot.settings, settingsDraft) : false

  return (
    <div className="shell">
      <div className="grain" />
      <WindowTitleBar
        isMaximized={isMaximized}
        onClose={handleCloseWindow}
        onMinimize={handleMinimizeWindow}
        onToggleMaximize={handleToggleMaximizeWindow}
      />
      <header className={`hero-panel ${viewMode === 'dashboard' ? 'dashboard-hero-panel' : ''}`}>
        <div className="hero-copy-block">
          {viewMode === 'dashboard' ? (
            <div className="hero-metrics hero-metrics-inline">
              <Metric label="Enabled" value={enabledCount} tone="linked" />
              <Metric label="Needs Migration" value={migrationCount} tone="available" />
              <Metric label="Issues" value={issueCount} tone="issues" />
            </div>
          ) : (
            <div className="settings-hero-copy">
              <p className="section-label">Settings</p>
              <h1>Workspace Settings</h1>
              <p className="muted-copy">
                Adjust the app theme and control which filesystem paths are scanned or managed.
              </p>
              <p className="settings-dirty-copy">{hasUnsavedSettings ? 'You have unsaved settings changes.' : 'All settings changes are saved.'}</p>
            </div>
          )}
        </div>
        <div className="hero-aside">
          <div className="hero-actions">
            {viewMode === 'dashboard' ? (
              <button
                className="icon-button"
                type="button"
                aria-label="Open settings"
                disabled={isBusy}
                onClick={() => setViewMode('settings')}
              >
                <SettingsIcon />
              </button>
            ) : (
              <>
                <button className="ghost-button" disabled={isBusy} onClick={() => setViewMode('dashboard')}>
                  Back to Dashboard
                </button>
                <button
                  className="primary-button"
                  disabled={!settingsDraft || !hasUnsavedSettings || isBusy}
                  onClick={() => void handleSaveSettings()}
                >
                  Save Settings
                </button>
              </>
            )}
            <button className="secondary-button" disabled={isBusy} onClick={() => void refreshSnapshot()}>
              Rescan
            </button>
            <button
              className="secondary-button"
              disabled={!snapshot || isBusy}
              onClick={() => snapshot && void handleOpenPath(snapshot.repositoryPath)}
            >
              Open Repository
            </button>
          </div>
        </div>
      </header>

      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      <main className="view-content">
        {!snapshot ? (
          <section className="loading-panel view-scroll-panel">Loading current skill state...</section>
        ) : viewMode === 'dashboard' ? (
          <div className="dashboard-view">
            {snapshot.migration.needed ? (
              <section className="migration-panel card-surface dashboard-migration-panel">
                <div className="migration-header">
                  <div>
                    <p className="section-label">Migration Assistant</p>
                    <h2>Move legacy skills into the shared repository</h2>
                    <p className="muted-copy">
                      Migration moves the single detected source directory into
                      <code>{snapshot.migration.repositoryPath}</code>
                      , removes conflicting filesystem entries when needed, then recreates matching links across the configured managed outputs.
                    </p>
                  </div>
                  <button
                    className="primary-button"
                    disabled={!snapshot.migration.canRun || isBusy}
                    onClick={() => void handleMigration()}
                  >
                    Run Migration
                  </button>
                </div>

                {snapshot.migration.items.length > 0 ? (
                  <div className="migration-list">
                    {snapshot.migration.items.map((item) => (
                      <article className="migration-item" key={item.skillName}>
                        <div>
                          <h3>{item.skillName}</h3>
                          <p className="muted-copy">Source: {item.sourcePath}</p>
                        </div>
                        <div>
                          <p className="migration-meta">Detected in: {item.sourceSurfaceName}</p>
                          <p className="migration-meta">Target: {item.repositoryPath}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}

                {snapshot.migration.cleanupWarnings.length > 0 ? (
                  <div className="warning-block">
                    <h3>Force cleanup before sync ({snapshot.migration.cleanupCount})</h3>
                    <ul>
                      {snapshot.migration.cleanupWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {snapshot.migration.issues.length > 0 ? (
                  <div className="issue-block">
                    <h3>Blocking issues</h3>
                    <ul>
                      {snapshot.migration.issues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            ) : null}

            <section className="matrix-panel card-surface dashboard-matrix-panel">
              <div className="matrix-header">
                <p className="section-label">Global Skill Switches</p>
                <div className="matrix-actions compact">
                  <div className="legend-row">
                    {Object.entries(SKILL_STATE_LABELS).map(([state, label]) => (
                      <span className={`legend-pill ${state}`} key={state}>
                        {label}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="matrix-panel-body">
                {snapshot.skills.length === 0 ? (
                  <div className="empty-state panel-empty-state">No skills detected yet. Add skills to a scanned path or run migration.</div>
                ) : (
                  <div className="skill-switch-list dashboard-skill-switch-list">
                    {snapshot.skills.map((skill) => (
                      <SkillSwitchRow
                        key={skill.skillName}
                        busy={busyToken === `toggle:${skill.skillName}` || isBusy}
                        onToggle={handleToggle}
                        skill={skill}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : (
          <section className="settings-view view-scroll-panel">
            {!settingsDraft ? (
              <div className="loading-panel">Loading settings...</div>
            ) : (
              <div className="settings-stack">
                <section className="settings-card card-surface">
                  <div className="settings-card-header">
                    <div>
                      <p className="section-label">Appearance</p>
                      <h2>Theme</h2>
                      <p className="muted-copy">Switch between dark and light themes.</p>
                    </div>
                  </div>

                  <div className="theme-options" role="radiogroup" aria-label="Theme mode">
                    <ThemeOption
                      active={settingsDraft.theme === 'dark'}
                      description="Low-glare dark workspace"
                      label="Dark"
                      onClick={() => handleThemeChange('dark')}
                    />
                    <ThemeOption
                      active={settingsDraft.theme === 'light'}
                      description="Bright high-contrast workspace"
                      label="Light"
                      onClick={() => handleThemeChange('light')}
                    />
                  </div>
                </section>

                <section className="settings-card card-surface">
                  <div className="settings-card-header">
                    <div>
                      <p className="section-label">Filesystem</p>
                      <h2>Managed outputs and scanned paths</h2>
                      <p className="muted-copy">Add, remove, or reset the paths used for managed link outputs and skill discovery.</p>
                    </div>
                    <div className="settings-toolbar">
                      <button className="ghost-button" disabled={!hasUnsavedSettings || isBusy} onClick={handleDiscardSettings}>
                        Discard Changes
                      </button>
                    </div>
                  </div>

                  <div className="settings-grid">
                    <PathListEditor
                      busy={isBusy}
                      description="These locations receive managed junction links when skills are enabled."
                      emptyCopy="No managed outputs configured yet. Add a path to start linking enabled skills."
                      onAddPath={() => handleAddPath('managedOutputPaths')}
                      onChangePath={(index, value) => handlePathChange('managedOutputPaths', index, value)}
                      onOpenPath={handleOpenPath}
                      onRemovePath={(index) => handleRemovePath('managedOutputPaths', index)}
                      onReset={() => handleResetPathList('managedOutputPaths')}
                      paths={settingsDraft.managedOutputPaths}
                      title="Managed Outputs"
                    />
                    <PathListEditor
                      busy={isBusy}
                      description="These locations are scanned for repository state, legacy skills, and migration candidates."
                      emptyCopy="No scanned paths configured yet. Add a path to discover skills outside the repository."
                      onAddPath={() => handleAddPath('scannedPaths')}
                      onChangePath={(index, value) => handlePathChange('scannedPaths', index, value)}
                      onOpenPath={handleOpenPath}
                      onRemovePath={(index) => handleRemovePath('scannedPaths', index)}
                      onReset={() => handleResetPathList('scannedPaths')}
                      paths={settingsDraft.scannedPaths}
                      title="Scanned Paths"
                    />
                  </div>
                </section>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  )
}

function WindowTitleBar({
  isMaximized,
  onClose,
  onMinimize,
  onToggleMaximize,
}: {
  isMaximized: boolean
  onClose: () => Promise<void>
  onMinimize: () => Promise<void>
  onToggleMaximize: () => Promise<void>
}) {
  return (
    <header className="window-titlebar">
      <div className="window-brand" aria-label="App title">
        <img alt="" aria-hidden="true" className="window-brand-badge" src={appIconUrl} />
        <span className="window-brand-title">Skills Switch</span>
      </div>
      <div className="window-controls" aria-label="Window controls">
        <button className="window-control" type="button" aria-label="Minimize window" onClick={() => void onMinimize()}>
          <span className="window-control-icon minimize" aria-hidden="true" />
        </button>
        <button className="window-control" type="button" aria-label={isMaximized ? 'Restore window' : 'Maximize window'} onClick={() => void onToggleMaximize()}>
          <span className={`window-control-icon ${isMaximized ? 'restore' : 'maximize'}`} aria-hidden="true" />
        </button>
        <button className="window-control close" type="button" aria-label="Close window" onClick={() => void onClose()}>
          <span className="window-control-icon close" aria-hidden="true" />
        </button>
      </div>
    </header>
  )
}

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  return <section className={`feedback-banner ${feedback.tone}`}>{feedback.text}</section>
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`metric-card ${tone}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function ThemeOption({
  active,
  description,
  label,
  onClick,
}: {
  active: boolean
  description: string
  label: string
  onClick: () => void
}) {
  return (
    <button className={`theme-option ${active ? 'active' : ''}`} type="button" role="radio" aria-checked={active} onClick={onClick}>
      <span className="theme-option-label">{label}</span>
      <span className="theme-option-description">{description}</span>
    </button>
  )
}

function PathListEditor({
  busy,
  description,
  emptyCopy,
  onAddPath,
  onChangePath,
  onOpenPath,
  onRemovePath,
  onReset,
  paths,
  title,
}: {
  busy: boolean
  description: string
  emptyCopy: string
  onAddPath: () => void
  onChangePath: (index: number, value: string) => void
  onOpenPath: (targetPath: string) => Promise<void>
  onRemovePath: (index: number) => void
  onReset: () => void
  paths: string[]
  title: string
}) {
  return (
    <div className="settings-list-card">
      <div className="settings-list-header">
        <div>
          <h3>{title}</h3>
          <p className="muted-copy">{description}</p>
        </div>
        <div className="settings-list-actions">
          <button className="ghost-button compact" disabled={busy} onClick={onReset}>
            Reset
          </button>
          <button className="secondary-button compact" disabled={busy} onClick={onAddPath}>
            Add Path
          </button>
        </div>
      </div>

      {paths.length === 0 ? (
        <div className="empty-state settings-empty-state">{emptyCopy}</div>
      ) : (
        <div className="settings-path-list">
          {paths.map((entryPath, index) => (
            <div className="settings-path-row" key={`${title}-${index}`}>
              <div className="settings-path-input-wrap">
                <span className="path-index">{index + 1}</span>
                <input
                  className="path-input"
                  disabled={busy}
                  onChange={(event) => onChangePath(index, event.target.value)}
                  placeholder="C:\\path\\to\\skills"
                  type="text"
                  value={entryPath}
                />
              </div>
              <div className="settings-path-actions">
                <button className="ghost-button compact" disabled={busy || !entryPath.trim()} onClick={() => void onOpenPath(entryPath)}>
                  Open
                </button>
                <button className="ghost-button compact destructive-button" disabled={busy} onClick={() => onRemovePath(index)}>
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function SkillSwitchRow({
  skill,
  busy,
  onToggle,
}: {
  skill: SkillRow
  busy: boolean
  onToggle: (skillName: string, enabled: boolean) => Promise<void>
}) {
  const isEnabled = skill.state === 'enabled'
  const canToggle = isEnabled ? skill.canDisable : skill.canEnable

  function handleSwitchClick(): void {
    if (isEnabled && skill.canDisable) {
      void onToggle(skill.skillName, false)
      return
    }

    if (!isEnabled && skill.canEnable) {
      void onToggle(skill.skillName, true)
    }
  }

  return (
    <article className={`skill-switch-row ${skill.state}`}>
      <strong>{skill.skillName}</strong>
      <span className={`state-badge ${skill.state}`}>{SKILL_STATE_LABELS[skill.state]}</span>
      <button
        className={`toggle-switch ${isEnabled ? 'on' : ''}`}
        type="button"
        role="switch"
        aria-checked={isEnabled}
        aria-label={`${isEnabled ? 'Disable' : 'Enable'} ${skill.skillName}`}
        disabled={!canToggle || busy}
        onClick={handleSwitchClick}
      >
        <span className="toggle-track">
          <span className="toggle-thumb" />
        </span>
        <span className="toggle-text">{busy ? 'Syncing' : isEnabled ? 'On' : 'Off'}</span>
      </button>
    </article>
  )
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" className="settings-icon" viewBox="0 0 24 24">
      <path d="M10.47 2.82a1 1 0 0 1 1.06 0l1.45.84a1 1 0 0 0 .81.08l1.58-.53a1 1 0 0 1 1.22.53l.75 1.5a1 1 0 0 0 .62.53l1.61.38a1 1 0 0 1 .78.96v1.68a1 1 0 0 0 .33.74l1.2 1.14a1 1 0 0 1 .22 1.14l-.68 1.54a1 1 0 0 0 0 .82l.68 1.54a1 1 0 0 1-.22 1.14l-1.2 1.14a1 1 0 0 0-.33.74v1.68a1 1 0 0 1-.78.96l-1.61.38a1 1 0 0 0-.62.53l-.75 1.5a1 1 0 0 1-1.22.53l-1.58-.53a1 1 0 0 0-.81.08l-1.45.84a1 1 0 0 1-1.06 0l-1.45-.84a1 1 0 0 0-.81-.08l-1.58.53a1 1 0 0 1-1.22-.53l-.75-1.5a1 1 0 0 0-.62-.53l-1.61-.38a1 1 0 0 1-.78-.96v-1.68a1 1 0 0 0-.33-.74L2.2 15.5a1 1 0 0 1-.22-1.14l.68-1.54a1 1 0 0 0 0-.82l-.68-1.54A1 1 0 0 1 2.2 9.32l1.2-1.14a1 1 0 0 0 .33-.74V5.76a1 1 0 0 1 .78-.96l1.61-.38a1 1 0 0 0 .62-.53l.75-1.5a1 1 0 0 1 1.22-.53l1.58.53a1 1 0 0 0 .81-.08zM12 8.5A3.5 3.5 0 1 0 12 15.5A3.5 3.5 0 1 0 12 8.5z" />
    </svg>
  )
}

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    theme: settings.theme,
    managedOutputPaths: [...settings.managedOutputPaths],
    scannedPaths: [...settings.scannedPaths],
  }
}

function areSettingsEqual(left: AppSettings, right: AppSettings): boolean {
  return left.theme === right.theme
    && areStringListsEqual(left.managedOutputPaths, right.managedOutputPaths)
    && areStringListsEqual(left.scannedPaths, right.scannedPaths)
}

function areStringListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  return left.every((entry, index) => entry === right[index])
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
