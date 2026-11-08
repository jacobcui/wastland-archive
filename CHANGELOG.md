# Changelog

All notable changes to Wasteland Archive are documented here.

## [1.1.9] — 2026-11-08

### Fixed

- HLS playback no longer stalls at the first segment for MPEG-TS files whose keyframes have missing/N/A timestamps (for example an `.mp4`-named TS file). The server now detects the unusable keyframe map, disables stream copy, and re-encodes each requested segment on demand.
- Keyframe probing now parses CSV timestamps with trailing commas and rejects GOP maps that contain `N/A` or implausibly dense keyframes, so a bad probe cannot silently enable stream copy.

## [1.1.8] — 2026-11-08

### Fixed

- Runtime HLS playback now aligns segments to source keyframes instead of fixed 2-second cuts, avoiding frame overlap/skips at segment boundaries.
- H.264/AAC sources are remuxed with stream copy instead of re-encoded with libx264, greatly reducing CPU and avoiding timestamp/frame judder. Unsupported codecs still use on-demand transcoding.
- Fallback remains 2-second segments if keyframe probing is unavailable, so a failed probe cannot produce a full-film segment.

## [1.1.7] — 2026-11-08

### Changed

- Server-backed media now uses on-demand, memory-backed HLS. The playlist is generated up front, but ffmpeg runs only when HLS.js requests a segment; segments are held in RAM (128 MB cap) and are released when playback stops/closes. Pausing stops further segment loading.
- No continuous full-film transcode process and no growing `~/.wasteland_archive/transcodes` directory for server-library videos. The legacy upload transcode route remains only for compatibility.

## [1.1.6] — 2026-11-08

### Added

- The Media “add folder” dialog now supports both pasting an absolute path and choosing a folder from the native system dialog. The native app uses Electron’s directory picker; dev-server/browser mode uses a server-side macOS/Windows/Linux folder chooser.

## [1.1.5] — 2026-11-08

### Fixed

- The Media add-folder dialog and storage note now show the single active media-home path returned by the running server, plus the active mode (dev server or native app), instead of the ambiguous “Application Support / ~/.wasteland_archive” wording.

## [1.1.4] — 2026-11-08

### Added

- Background update check against GitHub Releases: runs after startup, caches for 6 hours, and can be forced from the ↻ button next to the version badge.
- Update badge and release dialog with current/latest versions, platform-specific download asset, release notes and a link to the GitHub release.

## [1.1.3] — 2026-11-08

### Fixed

- Windows “在资源管理器中打开浏览目录” now uses Electron’s `shell.openPath` through a preload/IPC bridge; the server-side explorer call remains as a dev-browser fallback.
- MKX operator notes and the archive footer now show the real absolute `data/issues` path instead of `./data/issues`.

## [1.1.2] — 2026-11-08

### Changed

- Clear orphaned HLS segment directories from the media home on server startup. These are temporary transcode chunks, not media files; the legacy `data/transcodes` directory is also removed.

## [1.1.1] — 2026-11-08

### Fixed

- Automatically purge the legacy media Blob stores (`media`, `mediaFolders`, `mediaTranscodes`) from IndexedDB once at startup. 1.0.x copied every imported media file into these stores, which could consume hundreds of GB in the app profile. PDF and image-folder stores are preserved.
- Remove the old `data/transcodes` HLS cache directory on startup; new transcodes live under the media home directory.

## [1.1.0] — 2026-11-08

### Added

- Server-backed media library. Add an absolute directory path once; the server scans it and stores the index, positions, history and subtitle text in `~/.wasteland_archive` for the dev server and Application Support for the native app. Switching browsers keeps the same library.
- Server-side media streaming with byte ranges and server-side subtitle sidecars.
- Server-side transcoding directly from the original path, so unsupported formats no longer upload the whole file first.
- Full absolute paths in FILE INFO for server-library items.

### Changed

- Media metadata is no longer stored in browser IndexedDB. IndexedDB remains only for the separate PDF/image plugins.
- HLS transcode cache moved out of `data/` into the media home directory.
- Media import now starts from “添加目录路径” instead of a browser folder picker, because browsers cannot reveal an absolute path.

## [1.0.8] — 2026-11-08

### Added

- Video subtitles: auto-load a sibling `.srt` / `.vtt` for folder imports, manual subtitle selection, a CC show/hide toggle, and an overlay that also works in fullscreen.

## [1.0.7] — 2026-11-08

### Added

- Remove button in the play history (removes only the history entry, not the file).
- INFO button on every media row showing type, size and path, with copy; a folder root or file path can be set manually for the browser’s privacy-restricted paths.

### Fixed

- Large H.264/AAC MP4 files now try native playback first instead of being uploaded for transcoding. A 1.7 GB film starts immediately instead of waiting for a 1.7 GB local upload.
- Increased local transcode upload chunks to 32 MB for unsupported formats.
- History entries can be hidden without deleting the media item.

## [1.0.6] — 2026-11-08

### Fixed

- Large videos no longer fail immediately with “检查转码缓存…” after a previous aborted stream; stale transcode state is cleared and the source is re-resolved before retrying.
- Streaming now falls back to the saved folder/file handle if the in-memory file cache was lost.
- Clearer errors when the source file is no longer reachable, instead of leaving the last progress message.

## [1.0.5] — 2026-11-08

### Added

- Media play history panel with per-item progress; selecting a history entry continues from the saved position, or starts from the beginning if it already finished.

### Changed

- Fullscreen audio chrome now appears on any mouse movement instead of only near the top or bottom edges, and still fades out automatically after a few seconds.

## [1.0.4] — 2026-11-08

### Fixed

- Rolled the particle visualizer back to the lightweight 110-particle implementation for smooth playback; the fullscreen control chrome remains.

## [1.0.3] — 2026-11-08

### Added

- Per-media resume: switching tracks, leaving the plugin, quitting the app or reloading restores the last playback position; finished media starts from the beginning.
- Fullscreen audio visualizer chrome: file info, transport and progress fade in near the bottom edge; the close button and visual selector fade in near the top edge.
- Versioned release asset filenames.

### Changed

- Folder imports now save only metadata, file-handle references and playback positions. Media files are never copied into IndexedDB, `data/` or the app bundle; files stay in their original folders.
- Folder imports are batched and no longer write media blobs, making large movie folders much faster.
- Particle visualizer now uses 220 particles, trails, a frequency-driven glow and animated rings.

## [1.0.2] — 2026-11-07

### Changed

- Reduced the installed macOS app size from ~789 MB to ~585 MB (Apple Silicon) by excluding frontend-only build dependencies, unused PDF.js builds and FFmpeg UMD assets from the Electron bundle.
- Limited bundled Electron locales to English and Simplified Chinese.
- Removed the unused Playwright FFmpeg helper from the bundled browser resources.

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
