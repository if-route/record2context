# AGENTS.md

Guidance for an AI assistant (or a person) changing record2context.

## Asked to install or set up record2context?

Follow [`INSTALL-FOR-AI.md`](INSTALL-FOR-AI.md) from top to bottom: it builds the extension, installs the recording helper, gives the person their one Chrome step and runs the verify loop ([`VERIFY-FOR-AI.md`](VERIFY-FOR-AI.md), `npm run verify-install`) until it is `READY`. Do not improvise another setup.

## What it is

A Chrome extension plus a small local helper program. The extension records one tab; the helper (a Chrome native messaging host that Chrome starts on demand) writes each recording into a folder an AI can read. It records and points; it never tells the AI what to do, so do not add prompts, task instructions or AI calls.

```
popup (src/popup)           folder line or the "Not set up yet" line, Start / Stop, latest recording (Copy for my AI / Copy portable
                            context / Show folder / Delete), All recordings; opening it is a heartbeat
recordings (src/recordings) extension page: every recording and where it really is, player (OPFS first, else the folder through the
                            helper), Save to folder, Delete
background (src/background) session state in chrome.storage.session, pause/resume, writes report/screenshots to OPFS, hands the session
                            to the helper after Stop, copies waiting recordings when the helper answers, deletes, owns the recent list
host (host/)                the helper (record2context-host.mjs, Node built-ins only), its installer and the install verifier
offscreen (src/offscreen)   MediaRecorder (pause/resume), streams the video into OPFS, WebM container fix at Stop
content (src/content)       clicks, typing, keys, HUD (Screenshot / Stop with their keys, note box), Screenshot editor, element under a shape
main (src/main)             page-world fetch/XHR/history/console.error wrappers; request/response bodies (src/shared/bodies.ts)
        │ OPFS sessions/<id>/ ──after Stop, native messaging──▶ helper ──▶ <recordingsDir>/<id>/: <id>.webm,
        │                                     screenshot-NN.png, details/ (report.json, AI-README.md, context.md, private-do-not-share/)
```

- **Screenshot is a Mark.** The bar's Screenshot button was called Mark; code, messages and report.json (`mark` events, `marks`) keep that name so old and new recordings read alike. Only the words people and the AI-README see say Screenshot.
- `src/shared/clock.ts` maps wall-clock time to the video clock (paused time excluded). `event-log.ts` stores events with wall-clock `at`; `report.ts` turns them into `t` when the report is built. `marks.ts` opens and closes pauses and logs `mark` / `pause`.
- `src/shared/context.ts` builds `context.md` (the portable context) from the report. `ai-readme.ts` builds `AI-README.md`. `network.ts` / `network-dedupe.ts` classify and dedupe requests. `redact.ts` masks URLs and tokens, and redacts storage values (`redactStorageValue`). `layout.ts` is every path in a recording (top level for upload, `details/`, `details/private-do-not-share/`) and the old-layout fallbacks. `storage-snapshot.ts` reads and summarises localStorage/sessionStorage/cookie names; `bodies.ts` reads fetch/XHR bodies from clones within the caps.
- `src/shared/fs.ts` is the File System Access subset used on OPFS (typed structurally, so the test fake is interchangeable). `store.ts` is where recordings live: OPFS `sessions/<id>/`, copying to the folder through the helper, finding where a recording can be read, opening its files, deleting both copies. `host.ts` is the extension's side of the helper: one port, requests matched by id, 1 MiB write chunks, `status()` (ready / missing / broken), heartbeats. `setup.ts` is the "Not set up yet" text and the prompt it copies (repo path and build id baked in by `build.mjs`).
- `host/record2context-host.mjs` is the helper: framing, config (`recordingsDir`), path safety, the ops (`ping`, `write`, `finish`, `list`, `read`, `delete`, `reveal`, `selftest`), `status.json`. `host/install.mjs` installs it (launcher with absolute `node`, config, host manifest; idempotent), `host/verify.mjs` is `npm run verify-install`, `host/common.mjs` holds the names, locations and the extension id from the manifest `key`.
- `src/shared/recent.ts` is the recording list (entries with `paths` and `folderCopy.dir`, the absolute folder the helper reported), where-state text, and the "Copy for my AI" text. `session-actions.ts` holds the buttons the popup and the Recordings page share (Show folder asks the helper to open Finder) and the setup line.
- `src/shared/annotations.ts` is the shape model: swatches, numbering, geometry in image and CSS px, badge placement, the probe point. `src/content/editor.ts` draws it; `src/content/element-info.ts` describes the element under a box's centre or an arrow's tip.
- `src/shared/timeline.ts` builds the player's markers and row labels; `src/recordings/player.ts` is the player.
- `tests/` vitest unit tests. `e2e/` Playwright end-to-end tests against `e2e/fixtures/index.html`.

## Where to customise

| Want to change | Edit |
|---|---|
| What `context.md` / Copy portable context contains, or how it shrinks | `src/shared/context.ts` (+ `tests/context.test.ts`) |
| What the AI reads about the folder | `src/shared/ai-readme.ts` (+ its test in `tests/context.test.ts`) |
| The "Copy for my AI" text | `aiPointer` in `src/shared/recent.ts` (+ `tests/recent.test.ts`) |
| The report shape | `src/shared/types.ts` and `report.ts`; bump `SCHEMA_VERSION` and update `docs/reference.md` |
| Where a file of a recording goes (top level, `details/`, private folder) | `src/shared/layout.ts` (+ `tests/layout.test.ts`); `ai-readme.ts`, `docs/reference.md`, the README tree |
| What storage values may show in report.json; body caps and text types | `redactStorageValue` in `src/shared/redact.ts`, `src/shared/storage-snapshot.ts`, `src/shared/bodies.ts` (+ `tests/private-data.test.ts`, `tests/bodies.test.ts`, `e2e/data.e2e.mjs`) |
| The launcher, its launch log, the upgrade from the qa_recorder install | `launcherScript` / `LEGACY` in `host/common.mjs`, `removeLegacy` in `host/install.mjs`, `readLaunchLog` in `host/verify.mjs` (+ `tests/install.test.ts`, `tests/verify.test.ts`) |
| Where files are written, copied, read or deleted | `src/shared/store.ts` (+ `tests/host-client.test.ts`, `tests/storage.test.ts` with `tests/helpers/fake-fs.ts`) |
| What the helper accepts, where it writes, its status file | `host/record2context-host.mjs` (+ `tests/host.test.ts`); bump `HOST_VERSION`, and update the protocol table in `INSTALL-FOR-AI.md` |
| How the extension talks to the helper (chunks, timeouts, missing vs broken) | `src/shared/host.ts` (+ `tests/host-client.test.ts`) |
| What gets installed and where; what the verifier checks | `host/install.mjs`, `host/common.mjs`, `host/verify.mjs` (+ `tests/install.test.ts`, `e2e/host.e2e.mjs`); keep `INSTALL-FOR-AI.md` / `VERIFY-FOR-AI.md` in step |
| The "Not set up yet" line and its prompt | `src/shared/setup.ts`, `setupLine` in `src/shared/session-actions.ts` |
| What blocks a Start (helper missing or broken, Decision 11) | the `host.status()` check in `start()` in `src/background/index.ts` (the shortcut goes through it too), `setStartAllowed` in `src/popup/index.ts` (+ `e2e/popup.e2e.mjs`, `e2e/host.e2e.mjs`) |
| Recordings in an earlier recordings folder (read, delete, reveal at `folderCopy.dir`) | `existingSessionDir` / `roots.json` in `host/record2context-host.mjs`, `folderPresence` in `src/shared/store.ts` (+ `tests/host.test.ts`, `tests/host-client.test.ts`) |
| Shapes, colours, badges, per-shape notes | `src/shared/annotations.ts` (+ `tests/annotations.test.ts`), UI in `src/content/editor.ts` |
| What is recorded about the element under a shape | `src/content/element-info.ts` (+ `tests/element-info.test.ts`) |
| The HUD (buttons, note box, countdown) | `src/content/ui.ts`; behaviour in `src/content/index.ts` |
| How `t` is lined up with the video (t=0, pause cuts, picture lag) | `src/shared/clock-sync.ts` and `lagAt` / `videoTime` in `src/shared/clock.ts` (+ `tests/clock-sync.test.ts`) |
| Keyboard shortcuts and where their keys are shown | `commands` in `static/manifest.json`, `COMMANDS` in `src/shared/shortcuts.ts` (+ `tests/shortcuts.test.ts`), `isScreenshotShortcut` in `src/content/index.ts` |
| The Recordings page or the player | `src/recordings/` and `static/recordings.css`; markers and labels in `src/shared/timeline.ts` (+ `tests/timeline.test.ts`) |
| What Delete removes, when a recording counts as missing | `deleteSessionFiles` / `locate` in `src/shared/store.ts`, `whereState` in `src/shared/recent.ts` (+ `tests/recent.test.ts`) |

## Build and test

```bash
npm ci && npx playwright install chromium   # once: Playwright (a devDependency) and its Chromium for the E2E suites
npm run typecheck && npm test && npm run build
node e2e/local.e2e.mjs   # needs ffmpeg/ffprobe; headless Chromium, no window; e2e/host.e2e.mjs also needs Google Chrome
npm run e2e:local:xvfb   # optional: the same under Xvfb in Docker
```

E2E runs are headless by default and must never open a window on the developer's screen. `R2C_E2E_HEADED=1` shows the browser, for a person who wants to watch; do not set it in automated runs. A suite that needs a real display runs under Xvfb in Docker: `npm run e2e:xvfb -- <suite>`. Never fall back to a headed run on the host.

Run the first line before committing; run the local E2E after changing recording, pausing, saving or the popup, `e2e/pauses.e2e.mjs` after changing the clock, Mark, the countdown, the editor or the bar, `e2e/annotate.e2e.mjs` after changing the editor, shapes or element capture, `e2e/popup.e2e.mjs` and `e2e/recordings.e2e.mjs` after changing the list, Delete, storage, the setup line or the Recordings page, `e2e/data.e2e.mjs` after changing storage snapshots, bodies, the layout or redaction, and `e2e/host.e2e.mjs` after changing the helper, the installer, the verifier, `host.ts` or the install guide's commands.

`launch()` installs the real helper into each suite's own profile (`<user-data-dir>/NativeMessagingHosts`; nothing global), with its files in the system temp folder (Chrome cannot start a host under `~/Documents`) and its recordings folder at `e2e/.out/folder-<suite>/`; Show folder is logged to `e2e/.out/reveal-<suite>.log` instead of opening Finder. `e2e/host.e2e.mjs` runs the installed Google Chrome with a minimal environment and executes `INSTALL-FOR-AI.md`'s `<!-- e2e:… -->` command blocks, so renaming or editing those blocks changes the test. Never install into, or point a test at, the real `~/Library/Application Support/Google/Chrome/NativeMessagingHosts` or the person's real Chrome profile. The manual check in `docs/reference.md` lists what only a person can test. The host suite upgrades a temp copy of this machine's QA Recorder install (config rewritten to temp folders) and never touches the real one.

## Hard rules

1. **No server, no network calls of our own.** The extension never uploads, never calls an AI and never posts anywhere. Saving uses the extension's OPFS and the local helper (native messaging, stdio only); never `chrome.downloads` (it made Chrome show Save dialogs with "Ask where to save each file" on) and never a setting the person must change. The helper writes only inside its `recordingsDir`; keep the path checks in `host/record2context-host.mjs` and their tests.
2. **Never post to GitLab** (or anywhere) from this tool. GitLab posting is deferred (`ROADMAP.md`); if it is ever built, it must show the final text and ask every time.
3. **Never commit sessions, secrets or tokens.** Sessions live in the extension's storage and the recordings folder (default `~/record2context-recordings/`); the old `sessions/` and `e2e/.out/` stay out of git. Recordings hold whatever the recorded pages showed: screen content and page data. The manifest `key` is a public key; there is no private key in the repo, and none is needed for an unpacked extension (do not generate a new key: it changes the extension id on every machine).
4. Nothing that reaches `report.json`, `context.md`, a Mark note or a shape note may skip `src/shared/redact.ts` (and the input masking in `src/content/inputs.ts`). Raw page data (bodies, unredacted storage) goes only to `details/private-do-not-share/` and never into `report.json`, `context.md`, AI-README or the portable context; report.json may link to it by relative path or `bodyId`. No headers, no cookie values. Element capture never reads a field's value. A capture that fails (storage, a body) drops only that piece and records why; it never stops a recording or touches the page's own request or response.
5. **Typing in the HUD is never page input.** The HUD, note box and editor stop propagation of keyboard, input and pointer events, and the collectors ignore events whose path includes the HUD host. Keep both.
6. **`t` must stay a position in the video.** Any new event type must go through the event log (wall-clock `at`) so pauses and the frame-measured clock (`src/shared/clock-sync.ts`) are applied; check alignment with `e2e/pauses.e2e.mjs` and the flash test in `e2e/local.e2e.mjs`. The bar's dot, timer and countdown are how the recorder measures picture lag: keep them changing through `drawTick`, above the page, at a fixed place.
7. `context.md` must stay deterministic (same report, same text) and self-contained; do not reference local files from it except the video by name.
8. **The Mark editor and countdown never reach the video.** They only show while the recorder is paused; the editor is removed and the bar painted back before the countdown's first lag sample. `e2e/pauses.e2e.mjs` checks both.
