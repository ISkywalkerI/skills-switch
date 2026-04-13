# Contributing

Thanks for your interest in contributing to Skills Switch.

## Before You Start

- Read `README.md` first
- Check existing issues before opening a new one
- Keep changes focused and minimal
- Prefer small pull requests that are easy to review

## Development Setup

Requirements:

- Node.js 18+
- Windows

Install dependencies:

```bash
npm install
```

Start the app in development mode:

```bash
npm run dev
```

Run the minimum verification step before submitting changes:

```bash
npm run build
```

If your change affects packaging, also run:

```bash
npm run dist
```

Then smoke-test `release/win-unpacked/Skills Switch.exe`.

## Project Conventions

- Central repository is `~/.skills-repo/skills`
- Managed outputs are `~/.agents/skills` and `~/.claude/skills`
- Scanned paths include OpenCode legacy/config paths, Codex, and managed outputs
- Managed links use Windows junctions
- Preload must remain CommonJS
- `vite.config.ts` must keep `base: './'`

## Pull Request Guidelines

- Explain the problem and the fix clearly
- Include screenshots for UI changes when possible
- Mention any limitations or follow-up work
- Do not include unrelated refactors
- Update documentation when behavior changes

## Commit Messages

Use clear, concise commit messages. Examples:

- `feat: add force-clean migration confirmation`
- `fix: handle scanned path cleanup during migration`
- `docs: add GitHub community files`

## Reporting Bugs

When reporting a bug, please include:

- your OS version
- Node.js version if running from source
- the steps to reproduce
- the expected result
- the actual result
- screenshots or logs if available

## Feature Requests

Please describe:

- the problem you are trying to solve
- the proposed behavior
- any constraints or edge cases you already know about
