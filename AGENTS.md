# AGENTS.md

## Stack And Entrypoints
- Desktop app: Electron main process + React renderer + shared TypeScript models.
- Electron entrypoint is `src/electron/main.ts`; packaged app entry is `dist-electron/electron/main.js` from `package.json`.
- Renderer entry is `src/renderer/main.tsx`; Vite builds to `dist/`.
- Shared request/response types live in `src/shared/models.ts`. Keep IPC payload shapes in sync there first.

## Dev Commands
- Install deps: `npm install`
- Run app in dev: `npm run dev`
- Production build check: `npm run build`
- Build unpacked Windows app for zip release: `npm run dist`

## Build And Packaging Quirks
- `vite.config.ts` must keep `base: './'`. Using `/assets/...` breaks the packaged `file://` app and causes a black screen.
- Preload must stay CommonJS (`src/electron/preload.cts` -> `dist-electron/electron/preload.cjs`). An ESM preload fails with `Cannot use import statement outside a module` and `window.skillsSwitch` becomes undefined.
- `npm run dist` outputs to `release/win-unpacked/` only. Publish by zipping that directory instead of generating an `.exe` artifact.
- Windows packaging now uses `win.signAndEditExecutable: true` so the configured EXE icon is written during packaging.
- On some Windows setups, `npm run dist` may still need elevated privileges because `electron-builder` can fail while extracting `winCodeSign` symlinks.
- After replacing the EXE icon, Windows Explorer may continue showing the old icon until its icon cache is refreshed or the executable name changes.

## Project Structure
- `src/electron/config.ts`: default repository path, built-in host definitions, persisted config loading/saving.
- `src/electron/skill-service.ts`: scan logic, state classification, link enable/disable, migration flow.
- `src/electron/preload.cts`: exposes `window.skillsSwitch`; do not bypass it with renderer-side Node access.
- `src/renderer/App.tsx`: current UI and all user actions.

## Repo-Specific Behavior
- Default central repository is `~/.skills-repo/skills`.
- Built-in hosts are hardcoded:
  - OpenCode: `~/.agents/skills`
  - Claude Code: `~/.claude/skills`
  - Codex: `~/.codex/skills`
- Codex reserves `.system`; keep it out of normal skill scanning.
- Enable means creating a Windows `junction` with `fs.symlink(path, entryPath, 'junction')`.
- Disable only removes links. Real directories in host folders are intentionally not deleted automatically.

## Migration Semantics
- Current migration assumes the pre-migration world may contain real directories in host paths and old links between hosts.
- `runMigration()` moves the real source directory into the central repository with `fs.rename()`, then recreates host entries as managed junctions.
- Before changing state labels or migration rules, verify them against `classifyCell()` and `buildMigrationPreview()` in `src/electron/skill-service.ts`; the UI wording currently reflects those exact states.

## Verification Expectations
- There is no test or lint script yet. The minimum safe verification after code changes is `npm run build`.
- If you touch packaging, also run `npm run dist` and sanity-check `release/win-unpacked/Skills Switch.exe` before zipping the folder for release.
