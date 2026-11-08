# AGENT.md — Repository Agent Workflow

This file defines how an AI agent should handle update, fix and feature requests in
`jacobcui/wastland-archive`.

## Project briefing (read this before scanning the repo)

**Wasteland Archive / 废土馆藏** is a local-first desktop/browser archive of Chinese
magazines, PDFs, image folders and local media. Repository:
`jacobcui/wastland-archive`. Current version at the time of writing: **1.3.2**.

### Architecture

```text
Vue 3 + Vuetify + Vite (src/)
        │  same UI in a browser and Electron
        ▼
Express server (server/index.js)
  ├─ MKX archive sync + downloads
  ├─ PDF/static assets
  ├─ backgrounds
  ├─ media library index + file streaming
  ├─ ffmpeg HLS transcoding
  └─ update check against GitHub Releases
        ▲
Electron shell (electron/main.cjs) on native builds
  └─ spawns the same server on 127.0.0.1:5278
```

There are only two runtime modes:

| Mode | Entry | URL | Archive data | Media home |
| --- | --- | --- | --- | --- |
| Dev server | `make up` | `http://127.0.0.1:5178` | `<repo>/data` | `~/.wasteland_archive` |
| Native app | packaged Electron | `http://127.0.0.1:5278` | macOS: `~/Library/Application Support/wasteland-archive/data`; Windows: `%APPDATA%\wasteland-archive\data` | same Application Support root |

`data/` is the **portable magazine archive**. App state, media index and caches must
stay outside it.

### Repository map

| Path | Purpose |
| --- | --- |
| `src/App.vue` | shell, topbar, plugin deck, update badge/dialog |
| `src/plugins/mkx-archive/` | MKX magazine plugin |
| `src/plugins/pdf-reader/` | PDF plugin |
| `src/plugins/image-browser/` | image folder plugin |
| `src/plugins/media-player/` | media player, fullscreen visualizer, subtitles |
| `src/stores/` | archive/session/media/update plugin state |
| `src/lib/idb.js` | IndexedDB v5; also legacy media purge |
| `src/lib/platform.js` | platform labels and modifier keys |
| `src/styles/wasteland.css` | global shell styles |
| `src/i18n/locales/` | English / Chinese strings |
| `server/index.js` | Express routes and app wiring |
| `server/lib/config.js` | ROOT, DATA_DIR, media home, ports |
| `server/lib/media-library.js` | server media index, scan, file/subtitle resolution |
| `server/lib/store.js` | MKX issue files and local archive index |
| `server/lib/downloads.js` | serialized archive download queue |
| `server/lib/auth.js` | MKX session/auth |
| `electron/main.cjs` | native window, server spawn, reveal/pick-dir IPC |
| `electron/preload.cjs` | `window.wastelandDesktop` bridge |
| `scripts/build-native.sh` | macOS arm64 + x64 app/DMG/ZIP |
| `scripts/build-native-win.sh` | Windows x64 portable ZIP |
| `scripts/package-native.sh` | DMG layout/signing-free packaging |
| `Makefile` | dev, build, package and release helpers |

### Storage rules

- **MKX:** issues in `data/issues` (native: Application Support `data/issues`); auth in
  `data/auth.json`; download cache in `data/cache`. Downloads are serialized.
- **Media:** the library is server-side JSON:
  - dev: `~/.wasteland_archive/media-index.json`
  - native: Application Support `media-index.json`
  - Items are absolute folder paths + relative file paths. Media files are **never**
    copied into IndexedDB, `data/` or the app bundle. Playback is streamed by
    `/api/media-library/file/:id` with byte ranges.
  - Server-library video transcodes are **on-demand and memory-backed**: the full
    VOD playlist is generated, but ffmpeg runs only when HLS.js requests a segment.
    Segments live in an in-memory Map (128 MB cap), pause stops loading, and
    close/switch deletes the session. Do not reintroduce a continuous ffmpeg process
    or a growing segment directory for normal playback.
  - The legacy browser-upload transcode route uses a per-media-home/port OS temp
    directory (`os.tmpdir()/wasteland-archive-transcodes-<key>`) and deletes the
    root when empty.
    On every server start, remove the old `MEDIA_HOME/transcodes` and
    `DATA_DIR/transcodes` directories themselves; do not create them at boot.
  - Legacy 1.0.x media Blob stores (`media`, `mediaFolders`, `mediaTranscodes`) are
    purged once at startup. PDF/image IndexedDB stores are preserved.
- **PDF / Image:** still use IndexedDB `wasteland-browser`; do not remove those stores
  when touching media cleanup.
- **Backgrounds:** `~/.wasteland_browser/bg_screens`.

### Media library specifics

- Add-folder accepts an absolute path or a native folder dialog:
  - native: Electron `dialog.showOpenDialog` via preload IPC
  - dev: local server `osascript` / PowerShell / zenity / kdialog endpoint
- Browsers cannot reveal absolute paths; do not replace this with a plain
  `showDirectoryPicker`-only flow unless you also solve the server path.
- Server index endpoints: `GET /api/media-library`, `POST /api/media-library/folders`,
  rescan/delete/update item routes, `/file/:id`, `/subtitle/:id`.
- Browser-native playback is only attempted for MP4/WebM containers. The server
  exposes `container` and `nativePlayable`; MPEG-TS (including `.mp4`-named TS),
  Matroska, AVI etc. go straight to on-demand HLS so the browser never stalls on a
  demuxer it cannot handle.
- Stream copy is limited to MP4 H.264 sources with a reliable keyframe map. TS/MKV/AVI
  and unreliable probes re-encode on demand with libx264/AAC. Do not reintroduce
  full-file uploads.
- Re-encoded segments must use the pre-roll seek pattern: input
  `-ss (start - 12s) -noaccurate_seek`, then output-side `-ss 12s -t duration`.
  Keyframes with missing PTS make a direct `-ss start` accurate seek drop every
  video frame, producing audio-only fragments. Segment timestamps still start at
  the playlist position via `-output_ts_offset`.
- Every generated segment is checked for MPEG-TS video payload (PAT/PMT); a failed
  seek retries with a larger pre-roll. Do not serve audio-only fragments.
- ffprobe is optional (native builds do not bundle it). Probe failures disable
  stream copy; do not reintroduce the whole-file showinfo fallback.
- Scanner skips hidden files, including macOS AppleDouble `._name.mp4` sidecars.
- The playlist has a persisted **目录级 / 文件级** display switch. Folder level starts
  with folders collapsed and reveals a folder's files when it is expanded; file level
  expands all folders. It is a UI preference in localStorage, not part of the server
  media index.
- Plugin cards show the plugin name only. Per-plugin versions were removed because
  they drifted from the app version; use the app version/changelog instead.
- Subtitles: same-name `.srt`/`.vtt` is read from the folder; manual SRT/VTT loading
  is supported. The overlay uses `activeSubtitleText` in the video stage.
- Media versions/positions/history/subtitles are server-backed; do not move them back
  into browser IndexedDB.

### MKX / native gotchas

- Native archive files must be served from `ISSUES_DIR`, not the app bundle
  `ROOT/data`.
- Native Explorer/Finder reveal uses preload IPC (`shell.openPath`); the server
  `/api/reveal` route is a dev-browser fallback, not the primary native path.
- MKX operator notes show the full absolute `data/issues` path and a copy button.
- Windows native data path is `%APPDATA%\wasteland-archive\data`.
- x64 macOS builds may hang importing Playwright under Rosetta unless the import is
  lazy (already handled in `server/lib/auth.js` / `browser-sync.js`).
- DMG packaging uses a versioned volume name; stale mounted volumes can cause
  `hdiutil` resource errors. Detach stale images before rebuilding.
- The Windows ZIP is currently built on macOS; verify on real Windows when possible.

### Update check

- `GET /api/update?platform=...&arch=...&force=1` reads the latest GitHub Release.
  If the query omits platform/arch, the server uses its own `process.platform` /
  `process.arch`. Native builds send exact Electron values through the preload bridge.
- UI checks after startup, caches 6 hours, shows a topbar badge and dialog; ↻ forces a
  check.
- The update dialog shows the detected system and the matching asset. Native builds
  download to Downloads and open the DMG/ZIP through `wasteland:download-update`;
  browser mode opens the asset URL. Only allow GitHub download hosts.
- Do not silently replace the installed app binary; opening the official installer is
  the supported update path.
- Release bodies are shown as plain text in a scrollable details block.
- Do not use `v-html` for release notes.

### Canonical commands

```bash
make up                 # dev server at http://127.0.0.1:5178
make restart            # stop + start server; run npm run build separately for UI changes
npm run build           # Vite production build into dist/
make package            # web tarball release/wasteland-archive-<version>.tar.gz
make app                # macOS arm64 + x64 native apps/DMG/ZIP
make app-win            # Windows x64 portable ZIP
sh scripts/build-native.sh      # direct macOS build
sh scripts/build-native-win.sh  # direct Windows build
make upload-release-assets version=<version>  # upload local assets later
```

Current release workflow: build locally, create a GitHub Release with **notes only**
(no asset paths), then upload assets later with the Make target. See the release
checklist below.

### Fresh-session first steps

1. Read this file; do not start by scanning every plugin.
2. Check `git status`, `git log -3 --oneline`, `package.json` version and open issues:
   `gh issue list --repo jacobcui/wastland-archive --state open`.
3. Create a ticket for the requested change before editing (unless the user waives it).
4. Reproduce in the relevant mode; use the dev server for fast UI checks.
5. Keep `data/` and `release/` out of commits.
6. After implementation, test, bump/release if requested, close the issue, and report
   exact paths/commands used.

## Ticket-first workflow

Unless the user explicitly waives it, every requested update should follow this
sequence:

1. **Create a GitHub issue first**
   - Repository: `jacobcui/wastland-archive`
   - Title: short imperative description, e.g. `Fix Windows Explorer reveal button`
   - Body: user request, expected behaviour, affected platform, acceptance checks
   - Command:

     ```bash
     gh issue create --repo jacobcui/wastland-archive \
       --title "<short title>" \
       --body "<request, expected behavior, acceptance checks>"
     ```

2. **Record the issue number** returned by the command. Refer to it in the branch,
   commit and pull request, e.g. `Fixes #12` or `Closes #12`.

3. **Implement the change** on `main` or a dedicated branch, keeping the issue scope.
   Do not silently expand into unrelated work; create a separate issue for separate
   problems.

4. **Test** the change against the issue's acceptance checks. For desktop packaging
   changes, rebuild and verify the relevant artifact; for browser changes, verify the
   dev server at `http://127.0.0.1:5178`.

5. **Commit and push** with the issue reference in the commit message:

   ```bash
   git add -A
   git commit -m "Fix <summary> (Closes #<issue>)"
   git push origin main
   ```

6. **Release when appropriate** (see checklist below).

7. **Close the issue only after the implementation/test/release is complete**, with a
   short completion comment:

   ```bash
   gh issue close <issue> --repo jacobcui/wastland-archive \
     --comment "Implemented in <commit>, tested with <check>. Released as <version>."
   ```

## Ticket body template

```text
## User request
<what the user asked for>

## Expected behavior
<observable result>

## Scope / affected area
<plugin, server, native app, Windows/macOS, etc.>

## Acceptance checks
- [ ] ...
- [ ] ...
```

## Release checklist

For a user-visible update:

- Update `package.json` version.
- Update `CHANGELOG.md`.
- Update README versions/asset names when release asset names are versioned.
- Rebuild the affected artifacts:
  - `sh scripts/build-native.sh` for macOS arm64 + x64
  - `sh scripts/build-native-win.sh` for Windows x64
  - `make package` for the web package
- Verify release asset names contain the version.
- Create the GitHub release with **title, changelog and notes only**. Do **not** attach
  build artifacts during release creation; this keeps the release action fast.
- Keep the built assets in `release/` for later upload.
- Run the previous-version update check after publishing; the new release should be
  reported by `GET /api/update`.
- Close the issue with the release URL and commit hash.

### Uploading release assets later

Create the release without asset paths:

```bash
gh release create v<version> --target main \
  --title "Wasteland Archive <version> · 废土馆藏" \
  --notes-file CHANGELOG.md --latest
```

When the assets are ready to publish:

```bash
make upload-release-assets version=<version>
```

The target checks the local versioned files, confirms that the GitHub release exists,
and uploads with `--clobber`. It uploads:

- macOS arm64 and x64 DMG/ZIP
- Windows x64 ZIP
- web `wasteland-archive-<version>.tar.gz`

## Exceptions

- If GitHub CLI is unavailable or unauthenticated, report that ticket creation is not
  possible and proceed only if the user explicitly asks to continue without a ticket.
- A pure question that does not change the repository does not need a ticket.
- A one-line documentation typo may be handled without a ticket only if the user agrees,
  but the default remains ticket-first.

## Guardrails

- Never commit credentials, `data/`, `auth.json`, `.runtime/`, `release/`,
  `native-resources/`, `node_modules/`, `dist/` or logs.
- Keep media files in their original directories; the repository stores references,
  not media copies.
- Preserve the distinction between the portable `data/` archive and the media home
  (`~/.wasteland_archive` on dev, Application Support on native).
