# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning where practical.

## [Unreleased]

### Added

- Added scanning for `~/.config/opencode/skills`
- Added a secondary `Filesystem Surfaces` view
- Added a secondary skill detail view for `Managed Outputs` and `Detected In`
- Added force-clean migration support with explicit confirmation
- Added bilingual README files and GitHub community documents

### Changed

- Simplified the main `Global Skill Switches` view to show skill name, state, and switch only
- Moved filesystem surface details out of the dashboard into a dedicated view

### Fixed

- Allowed migration workflows to proceed by cleaning conflicting scanned entries after confirmation instead of blocking in more cases
