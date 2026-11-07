# Changelog

All notable changes to Wasteland Archive are documented here.

## [1.0.1] — 2026-11-07

### Changed

- New Wasteland Archive book-and-shield logo applied to the in-app brand mark, hero sigil, login dialog, favicon and app icons (macOS + Windows).
- Added the wordmark to the English and Chinese READMEs.

## [1.0.0] — 2026-11-07

First public version.

### Added

- **Wasteland Archive / 废土馆藏** brand and bilingual shell (English / 简体中文).
- Plugin deck with four local-first plugins: MKX magazine archive, PDF reader, image browser and media player.
- Native macOS app with bundled Node, Chromium, ffmpeg and Playwright.
- Background library: 11 bundled illustrated backgrounds, custom uploads, inner-page backgrounds and a **No background image** option.
- Particle / spectrum / waveform / terrain audio visualizers with a dedicated full-screen mode.
- Local HLS transcoding, resumable playback sessions and a WASM fallback for media.
- Persistent PDF, image and media libraries in IndexedDB.
- Serial archive download queue: one issue at a time, one page request at a time.
- “Refresh cache” action in the MKX plugin for archives copied into the native data directory.
- Drag-to-Applications DMG layout.

### Fixed

- Native archive covers and reader pages were served from the read-only app bundle instead of the native user-data directory.
- Archive media is now served only from `data/issues`; unrelated files under `data/` are not exposed.
- Audio visualizer file metadata moved from the canvas to the Now Playing strip.
- Legacy `wasteland-browser` native data is migrated into `wasteland-archive`.

### Packaging

- Apple Silicon (arm64) and Intel (x86_64) macOS packages with drag-to-Applications DMGs.
- Windows x64 portable package (`.zip`).
- Portable web package for `make up`.
