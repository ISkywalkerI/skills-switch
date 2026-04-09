import { useEffect, useState } from 'react'

import { CELL_STATE_LABELS } from '../shared/models'
import type { AppSnapshot, HostDefinition, SkillCell, SkillRow } from '../shared/models'

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

  async function handleToggle(cell: SkillCell): Promise<void> {
    const nextEnabled = cell.state !== 'enabled'
    setBusyToken(`${cell.hostId}:${cell.skillName}`)

    try {
      const result = await window.skillsSwitch.toggleSkill({
        hostId: cell.hostId,
        skillName: cell.skillName,
        enabled: nextEnabled,
      })

      setSnapshot(result.snapshot)
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

  async function handleAddHost(): Promise<void> {
    try {
      const directory = await window.skillsSwitch.chooseDirectory()
      if (!directory) {
        return
      }

      const suggested = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Custom Host'
      const name = window.prompt('Custom host name', suggested)
      if (name === null) {
        return
      }

      setBusyToken('add-host')
      const result = await window.skillsSwitch.addCustomHost({ name, path: directory })
      setSnapshot(result.snapshot)
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

  async function handleRemoveHost(host: HostDefinition): Promise<void> {
    const confirmed = window.confirm(`Remove the custom host ${host.name}? This does not delete files on disk.`)
    if (!confirmed) {
      return
    }

    try {
      setBusyToken(`remove:${host.id}`)
      const result = await window.skillsSwitch.removeCustomHost(host.id)
      setSnapshot(result.snapshot)
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
      setSnapshot(result.snapshot)
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

  return (
    <div className="shell">
      <div className="grain" />
      <header className="hero-panel">
        <div>
          <p className="eyebrow">Agent Skill Control Plane</p>
          <h1>Skills Switch</h1>
          <p className="hero-copy">
            Scan OpenCode, Claude Code, Codex, and any custom host directory. Each enabled skill is a managed
            junction into one shared repository.
          </p>
        </div>
        <div className="hero-actions">
          <button className="primary-button" disabled={isBusy} onClick={() => void refreshSnapshot()}>
            Rescan
          </button>
          <button className="secondary-button" disabled={isBusy} onClick={() => void handleAddHost()}>
            Add Custom Host
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
                  ? 'This repository already exists and is ready to host managed skills.'
                  : 'The repository will be created automatically when you migrate or enable the first managed skill.'}
              </p>
            </div>
            <div className="repository-badge">
              <span className={snapshot.repositoryExists ? 'status-pill live' : 'status-pill idle'}>
                {snapshot.repositoryExists ? 'Ready' : 'Pending'}
              </span>
              <span className="timestamp">Updated {formatTimestamp(snapshot.lastUpdated)}</span>
            </div>
          </section>

          <section className="hosts-grid">
            {snapshot.hosts.map((host) => {
              const summary = snapshot.hostSummaries[host.id]
              return (
                <article className="host-card card-surface" key={host.id}>
                  <div className="host-card-header">
                    <div>
                      <p className="section-label">{host.builtIn ? 'Built-in Host' : 'Custom Host'}</p>
                      <h3>{host.name}</h3>
                    </div>
                    {!host.builtIn ? (
                      <button className="ghost-button" disabled={isBusy} onClick={() => void handleRemoveHost(host)}>
                        Remove
                      </button>
                    ) : null}
                  </div>
                  <p className="path-chip">{host.path}</p>
                  <div className="host-metrics">
                    <Metric label="Linked" value={summary.enabled} tone="linked" />
                    <Metric label="Available" value={summary.disabled} tone="available" />
                    <Metric label="Issues" value={summary.issues} tone="issues" />
                  </div>
                  <button className="secondary-button compact" onClick={() => void handleOpenPath(host.path)}>
                    Open Host Directory
                  </button>
                </article>
              )
            })}
          </section>

          {snapshot.migration.needed ? (
            <section className="migration-panel card-surface">
              <div className="migration-header">
                <div>
                  <p className="section-label">Migration Assistant</p>
                  <h2>Move existing real skill folders into the shared repository</h2>
                  <p className="muted-copy">
                    The migration keeps the current enabled hosts, moves the real skill contents into
                    <code>{snapshot.migration.repositoryPath}</code>, then recreates junction links for each enabled host.
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
                        <p className="muted-copy">{item.sourcePath}</p>
                      </div>
                      <div>
                        <p className="migration-meta">Will enable in: {item.hostNames.join(', ')}</p>
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
                <p className="section-label">Skill Matrix</p>
                <h2>Per-host enable and disable switches</h2>
              </div>
              <div className="legend-row">
                {Object.entries(CELL_STATE_LABELS).map(([state, label]) => (
                  <span className={`legend-pill ${state}`} key={state}>
                    {label}
                  </span>
                ))}
              </div>
            </div>

            {snapshot.skills.length === 0 ? (
              <div className="empty-state">
                No skills detected yet. Add a host or run the migration assistant to centralize existing installs.
              </div>
            ) : (
              <div className="matrix-scroll">
                <table className="skills-table">
                  <thead>
                    <tr>
                      <th className="sticky-column">Skill</th>
                      {snapshot.hosts.map((host) => (
                        <th key={host.id}>{host.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.skills.map((skill) => (
                      <tr key={skill.skillName}>
                        <td className="sticky-column skill-name-cell">
                          <div className="skill-name-wrap">
                            <strong>{skill.skillName}</strong>
                            <span className={skill.inRepository ? 'repo-pill ready' : 'repo-pill pending'}>
                              {skill.inRepository ? 'In repository' : 'Needs migration'}
                            </span>
                          </div>
                          <span className="skill-path">{skill.repositoryPath ?? 'No central copy yet'}</span>
                        </td>
                        {snapshot.hosts.map((host) => (
                          <td key={`${skill.skillName}:${host.id}`}>
                            <SkillCellControl
                              busy={busyToken === `${host.id}:${skill.skillName}` || isBusy}
                              cell={skill.hosts[host.id]}
                              row={skill}
                              onOpenPath={handleOpenPath}
                              onToggle={handleToggle}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
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

function SkillCellControl({
  cell,
  row,
  busy,
  onToggle,
  onOpenPath,
}: {
  cell: SkillCell
  row: SkillRow
  busy: boolean
  onToggle: (cell: SkillCell) => Promise<void>
  onOpenPath: (targetPath: string) => Promise<void>
}) {
  const interactive = cell.state === 'enabled' || cell.state === 'disabled'

  return (
    <div className={`cell-card ${cell.state}`} title={cell.message}>
      {interactive ? (
        <button
          className={`toggle-switch ${cell.state === 'enabled' ? 'on' : 'off'}`}
          role="switch"
          aria-checked={cell.state === 'enabled'}
          disabled={busy}
          onClick={() => void onToggle(cell)}
        >
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
          <span className="toggle-text">{CELL_STATE_LABELS[cell.state]}</span>
        </button>
      ) : (
        <div className="state-badge-wrap">
          <span className={`state-badge ${cell.state}`}>{CELL_STATE_LABELS[cell.state]}</span>
          {cell.canDisable ? (
            <button className="inline-link" disabled={busy} onClick={() => void onToggle(cell)}>
              Remove link
            </button>
          ) : null}
        </div>
      )}

      {cell.targetPath ? (
        <button className="path-link" onClick={() => void onOpenPath(cell.targetPath!)}>
          {cell.state === 'disabled' && row.repositoryPath ? 'Open repository copy' : 'Open target'}
        </button>
      ) : null}
    </div>
  )
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString()
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
