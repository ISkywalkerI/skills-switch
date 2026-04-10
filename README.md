# Skills Switch

One-click global skill switching, fast and frictionless.

Install and manage skills freely, with zero mental overhead.

[中文说明 / Chinese Version](./README_CN.md)

Skills Switch focuses on one thing: unified global skill control.
Compared with tools like cc-switch that rely on fine-grained per-host control, this project takes a more direct approach. In practice, cc-switch-style control is not always reliable outside Claude Code, because hosts such as OpenCode and Codex may scan shared paths like .agents/skills. For that reason, Skills Switch removes host-by-host control and keeps only a simple, consistent global switch.
When enabled, a skill is available to all supported agents. Vice versa.

`Skills Switch` is a desktop GUI built with Electron, React, and TypeScript for managing shared AI agent skill directories from one place.

It keeps a single central repository as the source of truth, then syncs enabled skills into supported host directories through managed Windows junctions. This helps avoid duplicated copies, drift between hosts, and manual directory maintenance.

## Quick Start

### Option 1: Download and run the release package

1. Go to the project's GitHub `Releases` page
2. Download the latest release zip package
3. Extract the zip file to a local folder
4. Open the extracted folder
5. Run `Skills Switch.exe`

Notes:

- Do not run the app directly from inside the zip file
- Keep the extracted folder structure intact
- If Windows SmartScreen appears, confirm the app manually if you trust the release source

### Option 2: Run from source

```bash
npm install
npm run dev
```

### Build a release package locally

```bash
npm run build
npm run dist
```

Then:

1. Open the app
2. Click `Rescan`
3. Click `Run Migration`
4. Enable or disable the skills globally

## Features

- Scan multiple skill locations and detect existing skills, conflicts, and legacy layouts
- Use `~/.skills-repo/skills` as the central source of truth
- Enable or disable skills globally across managed outputs
- Migrate legacy skill directories into the central repository
- Preview `Managed Outputs`, `Detected In`, blocking issues, and force-cleanup warnings before migration
- Force-clean conflicting scanned directories or broken links after confirmation, then sync back to the central repository
- Review scanned and managed filesystem surfaces from a dedicated secondary view

## Supported Paths

### Central Repository

- `~/.skills-repo/skills`

### Managed Outputs

- `~/.agents/skills`
- `~/.claude/skills`

### Scanned Paths

- `~/.opencode/skills`
- `~/.config/opencode/skills`
- `~/.codex/skills`
- `~/.agents/skills`
- `~/.claude/skills`

Notes:

- `~/.agents/skills` and `~/.claude/skills` are both scanned and managed
- `.system` under `~/.codex/skills` is reserved and excluded from normal skill scanning

## Use Cases

- You use skills across OpenCode, Claude Code, Codex, or similar agent hosts
- You want to consolidate historical skill directories into one repository
- You want a single global switch per skill instead of managing each host manually
- You need a GUI to inspect conflicts, broken links, and migration state

## Tech Stack

- Electron
- React
- TypeScript
- Vite

## Project Structure

- `src/electron/main.ts`: Electron main process entry
- `src/electron/config.ts`: default paths, host definitions, config loading
- `src/electron/skill-service.ts`: scanning, classification, migration, enable/disable logic
- `src/electron/preload.cts`: secure IPC bridge exposed to the renderer
- `src/renderer/App.tsx`: UI and user interactions
- `src/shared/models.ts`: shared IPC and view models

## Requirements

- Node.js 18+
- Windows

This project currently targets Windows because managed syncing relies on Windows junctions.

## Installation

```bash
npm install
```

## Development

Run the app in development mode:

```bash
npm run dev
```

This starts:

- the Vite renderer dev server
- the Electron TypeScript watcher
- the Electron desktop app

## Build

Run the production build check:

```bash
npm run build
```

Use this to verify that:

- TypeScript compiles successfully
- the renderer bundle builds correctly
- the Electron main and preload bundles build correctly

## Package for Release

Build the unpacked Windows application:

```bash
npm run dist
```

Output:

- `release/win-unpacked/`

Notes:

- This project currently publishes the unpacked app directory instead of an installer
- For GitHub Releases, zip `release/win-unpacked/` and upload the archive as a release asset

## How to Use

### 1. Launch the app

Start the dev app with `npm run dev` or run the packaged `Skills Switch.exe`.

### 2. Review the dashboard

The main dashboard shows:

- the central repository path
- enabled skill count
- migration count
- issue count
- `Global Skill Switches`

### 3. Review filesystem surfaces

Click `Filesystem Surfaces` to open the secondary view for:

- `Managed Outputs`
- `Scanned Paths`

### 4. Enable or disable a skill globally

In `Global Skill Switches`:

- each row shows the skill name, state, and a switch
- turning a skill on syncs it from the central repository to managed outputs
- turning a skill off removes managed links from managed outputs

### 5. Review detailed skill placement

Click `Managed Outputs View` to inspect each skill's:

- `Managed Outputs`
- `Detected In`

The detail view is intentionally read-only and keeps path actions out of the way.

### 6. Run migration

When legacy skills are detected, the app shows `Migration Assistant`.

Typical flow:

1. Scan current skill locations
2. Identify skills that need migration into the central repository
3. Review migration items, force-cleanup warnings, and blocking issues
4. Click `Run Migration`
5. Let the app move or clean entries and resync managed outputs

## Migration Behavior

### Standard migration

If a skill exists in exactly one legacy location and does not yet exist in the central repository:

- the directory is moved to `~/.skills-repo/skills/<skill-name>`
- managed outputs are then linked to the central copy

### Force cleanup before sync

If the central repository already has a skill, but scanned paths still contain conflicting directories, stale links, or broken junctions:

- the app shows `Force cleanup before sync`
- `Run Migration` asks for confirmation
- after confirmation, conflicting scanned entries are removed
- managed outputs are then resynced to the central repository

This force-clean workflow applies to all scanned paths.

## Troubleshooting

### Blocking issues

If the UI shows `Blocking issues`, migration is currently not safe to run automatically.

Common causes:

- a skill path contains a file instead of a directory
- a path is in an unexpected state that cannot be cleaned safely
- a managed output contains a conflict that still requires manual intervention

Recommended steps:

1. Locate the path shown in the message
2. Back up the conflicting file or directory if needed
3. Clean up the conflict manually
4. Click `Rescan`
5. Retry migration or sync

### Force cleanup warnings

If the UI shows `Force cleanup before sync`, the app can proceed, but it will delete conflicting scanned directories or links after confirmation.

Recommended steps:

1. Confirm that the central repository has the correct version of the skill
2. Review the warning list carefully
3. Click `Run Migration`
4. Confirm the cleanup action

### Skill switch is disabled

If a skill cannot be toggled, it usually means:

- the skill is not yet present in the central repository
- the skill still needs migration
- the skill is in a conflict or partial state

Recommended steps:

1. Click `Rescan`
2. Review `Migration Assistant` and the detail view
3. Finish migration or resolve conflicts first

### Path open fails

If `Open Repository` fails:

- the directory may not exist yet
- the OS shell may not be able to open the requested path

Recommended steps:

1. Verify that the path exists
2. Run migration or enable at least one skill to create the directory
3. Retry the action

### Build succeeds but the app is broken

Check these project-specific constraints:

1. `vite.config.ts` must keep `base: './'`
2. the preload must remain CommonJS: `preload.cts -> preload.cjs`
3. packaging config must keep `win.signAndEditExecutable: false`

## Verification

### Minimum safe verification after changes

```bash
npm run build
```

Then manually verify:

- the dashboard renders correctly
- `Filesystem Surfaces` opens as a secondary view
- `Global Skill Switches` shows only name, state, and switch
- migration warnings and blocking issues display correctly

### Release verification

```bash
npm run dist
```

Then verify:

1. `release/win-unpacked/Skills Switch.exe` launches successfully
2. scan surfaces load correctly
3. enable and disable flows work
4. migration and force-cleanup flows work

## GitHub Release Checklist

1. Update the version if needed
2. Run `npm run build`
3. Run `npm run dist`
4. Manually smoke-test `Skills Switch.exe`
5. Zip `release/win-unpacked/`
6. Create a GitHub Release and upload the zip file

## Notes

- Do not treat managed outputs as your long-term storage location
- The central repository is the only source of truth
- Force cleanup deletes conflicting scanned directories or links, so confirm the central repository content first
- Regular files are never deleted automatically and must be handled manually

## License

MIT
