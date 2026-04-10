import { useEffect, useState } from 'react'

import { SKILL_STATE_LABELS } from '../shared/models'
import type {
  AppSnapshot,
  ManagedLinkStatus,
  ManagedSurfaceDefinition,
  ScanSurfaceDefinition,
  SkillLocation,
  SkillRow,
} from '../shared/models'

type Feedback = {
  tone: 'success' | 'error'
  text: string
}

export default function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null)
  const [busyToken, setBusyToken] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    void refreshSnapshot(true)
  }, [])

  async function refreshSnapshot(clearFeedback = false): Promise<void> {
    try {
      setBusyToken('refresh')
      const nextSnapshot = await window.skillsSwitch.getSnapshot()
      setSnapshot(nextSnapshot)
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

  async function handleMigration(): Promise<void> {
    try {
      setBusyToken('migrate')
      const result = await window.skillsSwitch.runMigration()
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

  const isBusy = busyToken !== null
  const enabledCount = snapshot?.skills.filter((skill) => skill.state === 'enabled').length ?? 0
  const migrationCount = snapshot?.skills.filter((skill) => skill.state === 'needsMigration').length ?? 0
  const issueCount = snapshot?.skills.filter((skill) => skill.state === 'invalid' || skill.state === 'conflict' || skill.state === 'partial').length ?? 0

  return (
    <div className="shell">
      <div className="grain" />
      <header className="hero-panel">
        <div>
          <p className="eyebrow">Global Agent Skill Control Plane</p>
          <h1>Skills Switch</h1>
          <p className="hero-copy">
            Scan legacy skill roots, keep one central repository authoritative, and mirror every enabled skill into
            <code>~/.agents/skills</code>
            and
            <code>~/.claude/skills</code>
            together.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" disabled={isBusy} onClick={() => void refreshSnapshot()}>
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
      </header>

      {feedback ? <FeedbackBanner feedback={feedback} /> : null}

      {!snapshot ? (
        <section className="loading-panel">Loading current skill state...</section>
      ) : (
        <>
          <section className="repository-panel card-surface">
            <div>
              <p className="section-label">Central Repository</p>
              <h2>{snapshot.repositoryPath}</h2>
              <p className="muted-copy">
                {snapshot.repositoryExists
                  ? 'This repository already exists and is the only authoritative skill store.'
                  : 'The repository will be created automatically when you migrate or enable the first managed skill.'}
              </p>
            </div>
            <div className="global-metrics">
              <Metric label="Enabled" value={enabledCount} tone="linked" />
              <Metric label="Needs Migration" value={migrationCount} tone="available" />
              <Metric label="Issues" value={issueCount} tone="issues" />
            </div>
          </section>

          <section className="surface-section card-surface">
            <div className="matrix-header">
              <div>
                <p className="section-label">Filesystem Surfaces</p>
                <h2>Discovery inputs and managed outputs</h2>
              </div>
            </div>

            <div className="surface-layout">
              <div>
                <p className="section-label">Managed Outputs</p>
                <div className="surface-grid">
                  {snapshot.managedSurfaces.map((surface) => (
                    <SurfaceCard key={surface.id} surface={surface} onOpenPath={handleOpenPath} />
                  ))}
                </div>
              </div>

              <div>
                <p className="section-label">Scanned Paths</p>
                <div className="surface-grid">
                  {snapshot.scanSurfaces.map((surface) => (
                    <SurfaceCard key={surface.id} surface={surface} onOpenPath={handleOpenPath} />
                  ))}
                </div>
              </div>
            </div>
          </section>

          {snapshot.migration.needed ? (
            <section className="migration-panel card-surface">
              <div className="migration-header">
                <div>
                  <p className="section-label">Migration Assistant</p>
                  <h2>Move legacy skills into the shared repository</h2>
                  <p className="muted-copy">
                    Migration moves the single detected source directory into
                    <code>{snapshot.migration.repositoryPath}</code>
                    , removes leftover legacy links, then recreates matching links in both managed surfaces.
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

          <section className="matrix-panel card-surface">
            <div className="matrix-header">
              <div>
                <p className="section-label">Global Skill Switches</p>
                <h2>One shared enabled state across all hosts</h2>
              </div>
              <div className="legend-row">
                {Object.entries(SKILL_STATE_LABELS).map(([state, label]) => (
                  <span className={`legend-pill ${state}`} key={state}>
                    {label}
                  </span>
                ))}
              </div>
            </div>

            {snapshot.skills.length === 0 ? (
              <div className="empty-state">No skills detected yet. Add skills to a scanned path or run migration.</div>
            ) : (
              <div className="skills-list">
                {snapshot.skills.map((skill) => (
                  <SkillCard
                    key={skill.skillName}
                    busy={busyToken === `toggle:${skill.skillName}` || isBusy}
                    onOpenPath={handleOpenPath}
                    onToggle={handleToggle}
                    skill={skill}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function FeedbackBanner({ feedback }: { feedback: Feedback }) {
  return <section className={`feedback-banner ${feedback.tone}`}>{feedback.text}</section>
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className={`metric-card ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function SurfaceCard({
  surface,
  onOpenPath,
}: {
  surface: ScanSurfaceDefinition | ManagedSurfaceDefinition
  onOpenPath: (targetPath: string) => Promise<void>
}) {
  const surfaceType = 'role' in surface ? (surface.role === 'primary' ? 'Primary Output' : 'Compatibility Output') : surface.managed ? 'Managed + Scanned' : 'Legacy Scan Only'

  return (
    <article className="surface-card">
      <div>
        <p className="section-label">{surfaceType}</p>
        <h3>{surface.name}</h3>
      </div>
      <p className="path-chip">{surface.path}</p>
      <p className="muted-copy">{surface.description}</p>
      <button className="secondary-button compact" onClick={() => void onOpenPath(surface.path)}>
        Open Directory
      </button>
    </article>
  )
}

function SkillCard({
  skill,
  busy,
  onToggle,
  onOpenPath,
}: {
  skill: SkillRow
  busy: boolean
  onToggle: (skillName: string, enabled: boolean) => Promise<void>
  onOpenPath: (targetPath: string) => Promise<void>
}) {
  return (
    <article className={`skill-card ${skill.state}`}>
      <div className="skill-card-header">
        <div>
          <div className="skill-name-wrap">
            <strong>{skill.skillName}</strong>
            <span className={`state-badge ${skill.state}`}>{SKILL_STATE_LABELS[skill.state]}</span>
          </div>
          <p className="skill-path">{skill.repositoryPath ?? 'No central copy yet'}</p>
        </div>
        {skill.repositoryPath ? (
          <button className="path-link" onClick={() => void onOpenPath(skill.repositoryPath!)}>
            Open Repository Copy
          </button>
        ) : null}
      </div>

      <p className="muted-copy">{skill.message}</p>

      <div className="skill-detail-grid">
        <div className="detail-block">
          <p className="section-label">Managed Outputs</p>
          <div className="managed-links-grid">
            {skill.managedLinks.map((link) => (
              <ManagedLinkCard key={link.surfaceId} link={link} onOpenPath={onOpenPath} />
            ))}
          </div>
        </div>

        <div className="detail-block">
          <p className="section-label">Detected In</p>
          {skill.locations.length === 0 ? (
            <div className="empty-inline">Only the central repository copy exists.</div>
          ) : (
            <div className="location-list">
              {skill.locations.map((location) => (
                <LocationCard key={`${location.surfaceId}:${location.entryPath}`} location={location} onOpenPath={onOpenPath} />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="skill-actions">
        {skill.canEnable ? (
          <button className="primary-button" disabled={busy} onClick={() => void onToggle(skill.skillName, true)}>
            {skill.state === 'partial' ? 'Repair Enable' : 'Enable Globally'}
          </button>
        ) : null}
        {skill.canDisable ? (
          <button className="secondary-button" disabled={busy} onClick={() => void onToggle(skill.skillName, false)}>
            Disable Globally
          </button>
        ) : null}
      </div>
    </article>
  )
}

function ManagedLinkCard({
  link,
  onOpenPath,
}: {
  link: ManagedLinkStatus
  onOpenPath: (targetPath: string) => Promise<void>
}) {
  const badgeTone = link.state === 'enabled' ? 'enabled' : link.state === 'missing' ? 'disabled' : 'invalid'
  const badgeLabel = link.state === 'enabled' ? 'Linked' : link.state === 'missing' ? 'Missing' : 'Conflict'

  return (
    <div className={`managed-link-card ${link.state}`}>
      <div className="skill-name-wrap">
        <strong>{link.surfaceName}</strong>
        <span className={`state-badge ${badgeTone}`}>{badgeLabel}</span>
      </div>
      <span className="skill-path">{link.entryPath}</span>
      <p className="muted-copy">{link.message}</p>
      <div className="inline-actions">
        <button className="path-link" onClick={() => void onOpenPath(link.entryPath)}>
          Open Path
        </button>
        {link.targetPath ? (
          <button className="path-link" onClick={() => void onOpenPath(link.targetPath!)}>
            Open Target
          </button>
        ) : null}
      </div>
    </div>
  )
}

function LocationCard({
  location,
  onOpenPath,
}: {
  location: SkillLocation
  onOpenPath: (targetPath: string) => Promise<void>
}) {
  const kindLabel = location.kind === 'link' ? 'Junction' : location.kind === 'directory' ? 'Directory' : 'File'

  return (
    <div className="location-card">
      <div className="skill-name-wrap">
        <strong>{location.surfaceName}</strong>
        <span className="repo-pill pending">{kindLabel}</span>
      </div>
      <span className="skill-path">{location.entryPath}</span>
      <div className="inline-actions">
        <button className="path-link" onClick={() => void onOpenPath(location.entryPath)}>
          Open Entry
        </button>
        {location.realPath ? (
          <button className="path-link" onClick={() => void onOpenPath(location.realPath!)}>
            Open Real Path
          </button>
        ) : null}
      </div>
    </div>
  )
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
