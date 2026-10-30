# record2context: reference

The full reference, in English, for developers and AI agents. The README (in Thai) is the short version. To install, follow `INSTALL-FOR-AI.md`.

A Chrome extension that records what you did in one tab and saves it as context an AI can use. It does not tell the AI what to do. It records and points; you write your own prompt for whatever you need (reproduce steps, debugging, a test, a question about a flow).

A recording is a folder named `<YYYY-MM-DD_HHmmss>_<host>`. Its top level holds only what you attach when you share it:

- a video of the tab (`<sessionId>.webm`), with a cursor dot and a ring at every click drawn into it
- `screenshot-NN.png`: the frame at each Screenshot, with your drawing when you drew on it (recordings made before Screenshot replaced Mark have `mark-NN.png`, and may have a separate `screenshot-NN.png`)

Everything else is in `details/`:

- `details/report.json`: every event with its time on the video: page loads and reloads, route changes, clicks, typing, Enter/Escape/Tab, fetch/XHR calls, console errors, your Screenshots (`mark` events) and the shapes you drew, storage snapshots (redacted), language and time zone
- `details/AI-README.md`: how to read the folder, for any AI
- `details/context.md`: a self-contained digest of the recording to paste into a chat or an issue comment
- `details/screenshots/screenshot-NN-original.png`: the plain frame of a Screenshot you drew on
- `details/private-do-not-share/`: raw page data for an AI on your own computer: localStorage/sessionStorage values unredacted (`storage/`) and fetch/XHR request and response bodies (`bodies/`). report.json, context.md and Copy portable context never contain any of it.

Every recording is kept in the extension's own storage first, then written to your recordings folder (by default `~/record2context-recordings`) by a small helper program that Chrome starts when needed. Chrome never shows a Save dialog, whatever its download settings say. There is no server. Nothing leaves your machine unless you paste or attach it somewhere.

## Install

**Let your AI do it.** Ask your AI agent (Claude Code, Codex, Cursor, …) with access to this computer: "Install record2context by following `<this repo>/INSTALL-FOR-AI.md`." It builds the extension, installs the helper, and has the result checked independently (`VERIFY-FOR-AI.md`, `npm run verify-install`) until it is ready. You only do one thing, when it asks: load the extension in Chrome once (chrome://extensions → Developer mode → **Load unpacked** → this repo's `dist` folder).

What gets installed (details and the manual route are in `INSTALL-FOR-AI.md`):

- The extension, `dist/`, loaded unpacked. Its id is fixed by the `key` in the manifest: `cmjkjjacbelgggcnknblelhepfmahgon`.
- The **recording helper**, a Chrome native messaging host (`host/record2context-host.mjs`, Node built-ins only). `npm run install-host` copies it to `~/Library/Application Support/record2context/` together with a launcher that holds the absolute path of `node`, writes `config.json` (`{ "recordingsDir": "…" }`), and registers it with Chrome (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.record2context.host.json`). To change the folder, edit `recordingsDir` in `config.json` or run `npm run install-host -- --recordings-dir <folder>`.

Needs Node 20+ and Chrome 127+. `ffmpeg` is only needed by the E2E tests (and by an AI that cuts frames). After `npm run build`, click the reload icon on record2context in `chrome://extensions`. Reloading keeps your recordings; **removing** the extension deletes the copies in its storage (the copies in your folder stay).

**Coming from QA Recorder (the earlier name)?** `npm run install-host` keeps its recordings folder and `roots.json`, then removes its host manifest (`com.qa_recorder.host`) and helper files; recordings are never deleted. The extension id is the same, so reloading the extension from the same `dist/` keeps its list and copies. A much older build had an id derived from its folder path; Chrome keeps each id's storage apart, so before removing such a build, use **Save to folder** on anything marked "In extension only".

## If the helper is not set up

**Start recording is blocked until the helper is set up and working.** Without it (not installed yet, removed, or its folder cannot be written), the popup and the Recordings page show one line, **Not set up yet — give this to your AI** (or **Recordings folder problem — give this to your AI**), with a **Copy** button that copies a short prompt pointing your AI at `INSTALL-FOR-AI.md` in this repo. The Start button stays disabled, and `Alt+Shift+R` opens that line instead of recording. A recording whose copy failed after it started (the helper was removed or broke during it) is kept in the extension. The extension copies it to the folder by itself as soon as the helper answers (when Chrome starts the extension, when you open the popup, or after the next recording), and **Save to folder** on the Recordings page does it on demand.

**Changing the recordings folder** (`recordingsDir` in `config.json`) moves nothing. New recordings go to the new folder; older ones stay where they were saved, and the extension keeps showing, playing, copying the path of and deleting each one at its own folder. The helper remembers every recordings folder it has used (`roots.json` next to `config.json`) and reads or deletes only directly inside those; it writes only into the current one.

## Record

1. Open the page where you want to start.
2. Click the record2context icon, then **Start recording** (or press `Alt+Shift+R`).
3. Work as usual. A bar at the bottom of the page shows the timer, **Screenshot** and **Stop**, each with its shortcut key; the popup lists the shortcuts too. Both read the keys from Chrome, so a key changed or cleared at `chrome://extensions/shortcuts` shows as it is (a cleared one shows "no key set"). Drag the timer to move the bar.
   - Reloading or moving to other pages in the same tab is fine; recording continues.
   - **Screenshot** (`Alt+Shift+S`) points at this moment. The video pauses, the extension captures the tab as it is and opens the editor on that frame. Draw if you like (see below), type a note for the moment (any length, Thai is fine) or nothing, then **Continue** or Enter in the note (Shift+Enter for a new line). A 3-2-1 countdown runs in the bar (still paused, not in the video), then recording resumes from the same point. The frame is saved as `screenshot-NN.png` (with your shapes when you drew, the plain frame then in `details/screenshots/`). Neither the editor nor the countdown is ever in the video. You can also Stop while paused.
4. Click **Stop**. The files are saved with no prompts: first in the extension, then written by the helper to `<recordings folder>/<YYYY-MM-DD_HHmmss>_<host>/`.

If the bar is gone (for example the page blocks scripts), use **Stop recording** in the popup. Closing the tab also stops and saves.

### Drawing on a screenshot

- **Box**, **Arrow** or **Pen**, and a colour for the next shape: red, yellow, green, cyan, magenta, white or black. The last colour you picked is remembered.
- Each shape gets a number badge (1, 2, 3...) in the image and its own note field in the side panel (Enter finishes the note). × removes a shape and renumbers the rest; Ctrl/Cmd+Z undoes the last one.
- For a box (its centre) or an arrow (its tip), the extension notes what is on the live page there: label, selector, test id, role, a bit of its text, its box, and a few computed styles (colour, background, font size and weight, display, visibility). It goes into `report.json` with the shape, so an AI knows exactly which element you meant.

## Use a recording

The popup shows where recordings go (or the setup line) and your latest recording that can still be read, with four buttons:

- **Copy for my AI**: a neutral pointer for an AI that can read your files, e.g.
  `Browser recording of what I did on app.test (1:23, recorded 2026-10-22 14:05): /Users/me/record2context-recordings/2026-10-22_140509_app-test — read details/AI-README.md there for the format.`
  Paste it, then ask your question. The path is the absolute folder the helper reported when it wrote the recording. Until the recording is in the folder, the button says to save it to the folder first.
- **Copy portable context**: the content of `details/context.md`, for an AI that cannot read your files or for an issue comment. It is collapsed in a `<details>` block, so it does not clutter the comment. Attach the video and the images from the top of the folder next to it.
- **Show folder**: opens the recording's folder in Finder (Explorer on Windows), through the helper. Without the helper it copies the path instead.
- **Delete**: asks first, then deletes the recording from the extension and, through the helper, from your folder (the session folder itself too).

### All recordings

**All recordings** in the popup opens the Recordings page (`chrome-extension://<id>/recordings.html`). It lists every recording, newest first (the last 200, kept in `chrome.storage.local`): host, start page (sensitive query values redacted), time, length, marks and where its files really are:

| Files | Means |
|---|---|
| In extension + folder | Both copies can be read |
| In extension only | Not in the folder (the copy failed, for example the helper was removed during the recording): it is copied once the helper answers, or **Save to folder** now |
| In extension (folder not checked) | Copied to the folder earlier; the helper is not reachable now, so the folder copy could not be checked |
| In folder | The extension's copy is gone; it plays from the folder (read back through the helper) |
| In folder (not checked) | Only the folder copy, and the helper is not reachable |
| Files missing | Neither copy can be found |

It never says a file is there unless it could read it. Each row has **Open**, the copy buttons, **Show folder**, **Save to folder** (when useful) and **Delete**. You can also tick several and **Delete selected**, **Remove missing from list** or **Clear list** (forgets every entry; the files stay).

**Open** plays the recording: the language, locale and time zone at Start, the video, a timeline with a colour-coded marker for every Screenshot, click, input, key, page load or route change, network error and console error, your Screenshots with their notes and images, and Events / Network / Console / Screenshots / Storage tabs (each screenshot with its numbered shapes and notes). Click a marker, a Screenshot or a row to seek; with **Follow playback** on, the row nearest the video time is highlighted and scrolled into view. Long URLs are shortened with a **more** toggle. Files are read from the extension's storage first, else from your folder through the helper.

The page also shows what is kept in `details/private-do-not-share/`, labelled as private: **Storage** lists each snapshot (Start, each Screenshot, Stop) with its localStorage and sessionStorage entries and cookie names, unredacted from the snapshot's private file, or the redacted report.json values (labelled so) when that file cannot be read. In **Network**, a call whose bodies were kept has a **Body** button that opens its request and response (JSON indented), and a line above the list gives the body counts from `report.privateData`. None of this is ever added to Copy portable context, Copy for my AI, context.md or report.json.

## Output

```
<recordings folder>/<YYYY-MM-DD_HHmmss>_<host>/
  <YYYY-MM-DD_HHmmss>_<host>.webm              the video
  screenshot-01.png                            Screenshot 1: with your shapes if you drew, else the plain frame
  details/
    report.json
    AI-README.md
    context.md
    screenshots/screenshot-01-original.png     Screenshot 1's plain frame (only when you drew on it)
    private-do-not-share/
      README.txt
      storage/01-start.json, 02-mark-1.json, …, NN-stop.json   localStorage, sessionStorage (unredacted), cookie names
      bodies/<bodyId>.json                     one fetch/XHR call: request and response text, or why it was skipped
```

Paths in report.json are relative to the recording folder. A recording saved before `details/` existed keeps every file at the top (`report.json`, `screenshots/NN.png`); the Recordings page, Copy for my AI (it then names `AI-README.md`) and the helper still read it.

The video is named after the session so several clips attached to one issue never collide. The folder name uses local time and the start page's host, with `:` → `_` and dots → `-` (`127.0.0.1:8080` → `127-0-0-1_8080`, `my-app.example.app` → `my-app-example-app`): on macOS Finder shows a folder ending in `.app` as an application bundle you cannot open. Two recordings started in the same second get `-2`, `-3`. Screenshots are saved as soon as you click Save (or press Mark); the rest on Stop. The same layout is kept in the extension's storage (`sessions/<id>/` in its origin-private file system).

## report.json

```jsonc
{
  "schemaVersion": 5,
  "generator": { "name": "record2context", "version": "0.1.0" },
  "startedAt": "2026-10-22T07:57:26.360Z", // wall-clock time of the first video frame (t = 0)
  "durationMs": 28798,                       // the video's own duration (paused time excluded)
  "pausedMs": 4200,                          // total time paused by Screenshots (sum of the pause events)
  "stopReason": "user",                      // "user" | "tab-closed" | "capture-ended"
  "startUrl": "https://example.test/home",
  "browser": { "userAgent": "...", "os": "mac", "arch": "arm64", "language": "th-TH", "languages": ["th-TH", "en"],
               "locale": "th-TH", "timeZone": "Asia/Bangkok", "utcOffsetMinutes": 420 },
  "viewport": { "width": 1280, "height": 800 }, // CSS px at Start
  "devicePixelRatio": 2,
  "video": { "file": "<sessionId>.webm", "mimeType": "video/webm", "width": 2560, "height": 1600,
             "durationMs": 28798, "sizeBytes": 4012345, "seekableFix": true },
  "timeline": { "t": "...", "pauses": "...", "coordinates": "...", "path": "...", "network": "..." },
  "counts": { "events": 61, "byType": { "click": 5, "network": 40 }, "networkDropped": 0 },
  "screenshots": [{ "file": "details/screenshots/screenshot-01-original.png", "t": 9120, "mark": 1, "annotatedFile": "screenshot-01.png", "annotations": [ /* see below */ ] }],
  "marks": [{ "n": 1, "t": 9120, "note": "...", "screenshot": "details/screenshots/screenshot-01-original.png", "annotatedScreenshot": "screenshot-01.png" }],
  "pauses": [{ "t": 9120, "pausedMs": 4200, "correctionMs": 0.4 }],
  "clockSync": {                             // how t was lined up with the video's own frames (see Time)
    "source": "video-frames",                // or "wall-clock" with a "reason" when frame timing was unavailable
    "startShiftMs": -31.2,                   // t=0 moved to the first frame's capture time
    "framesMatched": 812, "videoFrames": 812, // the file's frames found among the frames seen while recording
    "pauses": [{ "n": 1, "wallMs": 4199.6, "videoMs": 4200.0, "correctionMs": 0.4, "framesMatched": 40 }],
    "lag": [{ "t": 0, "ms": 3.1, "minMs": 1.9, "maxMs": 4.2, "samples": 30 },   // per stretch between pauses
            { "t": 9120, "ms": 35.2, "minMs": 34.6, "maxMs": 36.8, "samples": 14 }]
  },
  "storage": [{ "n": 1, "label": "start", "t": 24, "origin": "https://app.test",   // also "mark-N" and "stop"
                "local": { "keys": 3, "entries": [{ "key": "authToken", "value": "[REDACTED]", "length": 180, "redacted": true },
                                                  { "key": "theme", "value": "dark", "length": 4 }] },
                "session": { "keys": 0, "entries": [] }, "cookieNames": ["sid"],
                "privateFile": "details/private-do-not-share/storage/01-start.json" }],          // or "error" when unreadable
  "privateData": { "dir": "details/private-do-not-share", "note": "...", "storageFiles": ["..."],
                   "bodies": { "saved": 12, "bytes": 48211, "skipped": { "not a text type (image/png)": 3 } } },
  "events": [ /* ordered by t */ ]
}
```

**Time.** Every event has `t`: milliseconds on the video clock, 0 = first frame, paused time left out. So `t` is always a position in the video, and `ffmpeg -ss <t>` gives the first frame drawn at or after the event (the frame showing the screen as it was then, with the event's own change if the page drew it in that frame). The clock is lined up with the video's own frames, not with when the extension called the recorder; `clockSync` lists every correction:

- **t = 0** is the capture time of the first frame in the file. The recorder's `start` event comes 10-120 ms later (`startShiftMs`).
- **Pauses.** Each pause is exactly what the recorder cut, measured by matching every frame seen while recording against the file's frame times (`clockSync.pauses`, `correctionMs` on each `pause` event). In practice this equals the time between the pause and resume calls to within about 1 ms.
- **Picture lag.** A captured frame shows what the page drew 2-70 ms before its capture time, and Chrome changes this in steps of one 60 Hz frame (for example after a busy frame, often at a Mark). The bar changes every 250 ms (an invisible 3 px beacon flips between two near-identical shades; the dot and timer change too, and the countdown before each resume) and reports when. The frame log runs at 60 fps, so it sees every frame the page draws, and the first logged frame that shows each change measures the lag exactly. The median of the 5 nearest measurements taken in the same stretch after its resume (the countdown's if there are fewer than 3) is added to `t`, less 8 ms so `t` lands just before that frame. `clockSync.lag` lists it per stretch. Keep the bar uncovered and in place; it is drawn above the page for this reason.

At a Screenshot (a `mark`), the last frame before `t` is the moment you pressed Screenshot; the first frame at `t` is after the countdown. An event that happened while paused (a request, a console error, a route change) has `t` = the pause point and `duringPause: true`. Every event also has `path` (`pathname + search + hash`, sensitive query values redacted); events from an iframe have `frame: { url, translated }`.

| type | fields |
|---|---|
| `page_load` | `navigationType` (`navigate`, `reload`, `back_forward`, `prerender`), `initial` (true for the page open at Start), `url`, `title`. For later loads `t` is the navigation start. |
| `route_change` | `from`, `to`, `via` (`pushState`, `replaceState`, `popstate`, `hashchange`) |
| `click` | `label` (never empty), `labelSource`, `tag`, `role?`, `testId?`, `selector`, `bbox`, `point`, `viewport { width, height, dpr, scrollX, scrollY }`, `href?` |
| `input` | `selector`, `label`, `tag`, `inputType`, `value` (max 200 chars), `valueLength`, `masked`, `truncated`. `t` is the last keystroke. |
| `key` | `key` (`Enter`, `Escape`, `Tab`), `modifiers`, `selector`, `label`, `tag` |
| `network` | `method`, `url`, `status` (0 = failed or hidden), `durationMs`, `source` (`fetch`, `xhr`, `resource-timing`), `error?`, `bodyId?`. `t` is the request start. No headers; `bodyId` names `details/private-do-not-share/bodies/<bodyId>.json` and is set only when that file was written. |
| `console_error` | `source` (`console.error`, `window.error`, `unhandledrejection`), `message` (max 1000 chars), `stack?` (first 6 lines) |
| `screenshot` | `file`, `viewport`, `imageWidth`, `imageHeight`, `annotated`, `annotations?`. `t` is when the frame was captured. It has `mark` (its `n`, same `t`) and `annotatedFile` when you drew; its `file` is the plain frame. Older recordings may also have one without `mark`, from the old separate Screenshot button. |
| `mark` | One per Screenshot (the bar's button was called Mark before; the report keeps the name so old and new recordings read the same). `n` (1-based), `note` (may be empty), `screenshot?` and `annotatedScreenshot?` (the frame captured while paused). The video paused here. |
| `pause` | `pausedMs` (what the video cut), `correctionMs` (added to the measured pause to match the cut), at the same `t` as its mark. The video has no frames for that time. |

`report.json` keeps every event and every network row (up to the latest 2000 network rows; `counts.networkDropped` says how many older ones were dropped). Clicks, typing, marks and other actions are never dropped. Typing in the Mark note or a shape note is never logged as page input.

**Annotations.** One per shape drawn on a screenshot, numbered like its badge in the image:

```jsonc
{ "n": 1, "shape": "box",              // box | arrow | pen
  "color": "yellow", "hex": "#facc15",
  "geometry": { "image": { "x": 104, "y": 364, "width": 330, "height": 66 },   // PNG px
                "css":   { "x": 52,  "y": 182, "width": 165, "height": 33 } }, // page CSS px = image * viewport.width / imageWidth
  "note": "field too narrow",
  "element": { "tag": "input", "label": "Title", "labelSource": "label", "selector": "input[name=\"title\"]",
               "bbox": { "x": 58, "y": 188, "width": 153, "height": 21 },
               "style": { "color": "rgb(0, 0, 0)", "backgroundColor": "rgb(255, 255, 255)", "fontSize": "13.3333px",
                          "fontWeight": "400", "display": "inline-block", "visibility": "visible" } } }
```

An arrow's geometry is `{ from, to }` (`to` is the tip), a pen stroke's `{ points, bbox }` (at most 64 points). `element` is only for boxes (the element at the centre) and arrows (at the tip): the topmost element there on the live page when the shape was drawn, resolved to the nearest button/link/field like a click, with `testId`, `role`, `text` (80 chars, never a field's value), `inheritedBackground` when its own background is transparent, and `iframe: true` when it is an iframe. Shape notes go through the same token scrubbing as Mark notes.

**Click labels.** For buttons, links and other elements the label is the first non-empty of: visible text, input button value, `aria-label`, `aria-labelledby`, `title`, `alt`, `placeholder`, test id, associated `<label>`, nearest heading before the element, a readable class name, the tag name. For form fields and rich editors the name sources come first and visible text last. `labelSource` says which one was used.

**Mapping to pixels.** `bbox` and `point` are CSS pixels in the top-level viewport at event time:

```
scale  = min(video.width / viewport.width, video.height / viewport.height)
offset = ((video.width  - viewport.width  * scale) / 2,
          (video.height - viewport.height * scale) / 2)
videoX = offset.x + x * scale
```

The video size is fixed at Start (viewport × devicePixelRatio, longest side at most 2560). For screenshots: `pixel = css * imageWidth / viewport.width`.

**Cutting a frame at an event:** `ffmpeg -ss <t/1000> -i <sessionId>.webm -frames:v 1 frame.png`.

**Privacy.** Password and email fields (`type=email`, autocomplete containing `email` or `username`) and fields whose name, id, label, placeholder or autocomplete looks sensitive (password, token, secret, API key, one-time code, card number, CVV, PIN, email / e-mail / อีเมล, ...) are logged as `[MASKED]` with their real length; contenteditable editors too. Email addresses in every other captured string (URLs and query strings, typed values, click and field labels, page titles, console errors and stacks, text under a shape, selectors) are replaced with `[EMAIL]`, in `report.json` and `context.md`, because the portable context gets pasted into GitLab. **Mark notes and shape notes are left as you wrote them**: an address you type there stays. Copy portable context on a recording made before email masking rebuilds the text from its `report.json` (notes kept); when that file cannot be read, every address in the kept text is replaced, notes included. Sensitive query parameters in URLs are `[REDACTED]`. JWTs and `Bearer`/`Basic` tokens are removed from console messages and Mark notes. Headers and cookie values are never recorded. The video records whatever is on screen, so it can show anything typed.

**Storage and bodies.** At Start, each Screenshot and Stop the extension reads the recorded page's localStorage, sessionStorage and cookie *names* (`document.cookie`, names only). report.json gets each key with its value redacted and cut to 120 characters: the whole value when the key name looks sensitive (token, auth, session, sessid, secret, password, passcode, key, jwt, cookie, credential, csrf, refresh, access, signature, otp, and the whole words pass, pw, pin, sid, sig, so `passenger` or `pinned` stay), per field inside JSON values (also JSON kept as a string inside JSON, up to 10 levels; deeper, or JSON cut at the size cap, is hidden whole), and by shape everywhere: JWTs, `Bearer`/`Basic` tokens, emails, known key prefixes (`AKIA`/`ASIA`, `sk-`, `ghp_`/`gho_`/`github_pat_`, `xoxb-`/`xoxp-`/`xoxa-`/`xoxs-`, `AIza`, `glpat-`), and pieces of 16+ characters with no space that mix letters and digits (or reach 40 token characters), unless they are plain words or repetitive. Paths and host names are judged per `/` or `.` piece, so `/projects/12345/edit` and `api2.example.com` stay readable; a UUID or hex id counts as random and is hidden. The same shape rules apply to console errors, labels, page titles, element text and typed values (not to your own Mark and shape notes, which only lose JWT/Bearer tokens). At most 500 keys per area, 64 KiB per value and 1 MiB per snapshot are read. The unredacted snapshot goes only to `details/private-do-not-share/storage/`. Fetch and XHR bodies go only to `details/private-do-not-share/bodies/`: text types only (`text/*`, JSON, XML, JavaScript, form-urlencoded, GraphQL), at most 256 KiB (UTF-8 bytes) each and 10 s of reading, at most 500 files and 20 MiB per recording. Responses are read from `response.clone()` and a Request object's body from `request.clone()` (made before `fetch` runs), so the page's own body is never consumed and a streaming response keeps streaming; the clone is cancelled at the cap. FormData, Blob, binary and stream request bodies are not read; each skipped body says why. A failure to read storage or a body only drops that piece (and says why); the recording continues.

## context.md

`context.md` and **Copy portable context** hold the same text: a one-line header, then one JSON block, inside `<details><summary>Context for AI (record2context)</summary>`. It is built from `report.json` by the extension (`src/shared/context.ts`): deterministic, no AI, and readable without any local file.

| Key | What it holds |
|---|---|
| `contextVersion`, `reportSchemaVersion`, `generator`, `session`, `recordedAt`, `startUrl` | What this is |
| `environment` | `frontendHost` and the other hosts requests went to (`apiHosts`) |
| `client` | Browser, OS, arch, viewport, DPR |
| `video` | File name, duration, size, paused time |
| `pauses`, `marks` | Each pause and each mark with its note and screenshot |
| `actions` | In order: page loads, route changes, clicks, inputs (masked), keys, each with `t`, on-screen label and its source, selector, test id, role, href/route, and `requests`: what started between it and the next action, identical requests counted once |
| `requestsBeforeFirstAction`, `consoleErrors` | |
| `screenshots` | Each screenshot (`mark` for a Screenshot's frame) with `shapes`: number, shape, colour, note, `box` / `tip` in CSS px and `on` (the element: tag, label, test id, role, text, and while it fits selector and a one-line style) |
| `replay` | Steps a machine can follow: `goto`, `click {label, selector, testId}`, `fill {selector, value or [MASKED]}`, `key`, `reload`, `navigate`, each with `t` and the requests to `expect` after it. A navigation within 3 s of a click or key is flagged `causedByPrevious`. Requests made while paused are not expected. |
| `network` | All requests: `errors` (status ≥ 400, or a failed fetch/XHR) one by one, everything else grouped by method + URL + status with `count`, `firstT`, `lastT` |

URLs on the start page's host are shown as paths, other hosts as `//host/path`. Everything goes through the recorder's redaction again. If the text would exceed 60,000 characters, the least important parts shrink first (repeated-request groups, then requests per action, then selectors outside `replay`, then text length, then fields per action; actions are cut only as a last resort), and a `shortened` list inside the block says what was cut.

## How it works

- **Video.** `chrome.tabCapture.getMediaStreamId` plus an offscreen document running `MediaRecorder` (VP9, 3 Mbit/s, a keyframe every second, no audio). The recorder lives outside the page, so reloads and navigation do not stop it. **Mark** calls `MediaRecorder.pause()`; Chrome leaves the paused time out of the file. Capture runs at 60 fps; the recorder's track is limited to 30 fps (the video), and a clone of the 60 fps track is read frame by frame (`MediaStreamTrackProcessor`) for each frame's timestamp and the pixels where the bar is; on Stop these are lined up with the file's frame times to place t=0, each pause and the picture lag exactly (`src/shared/clock-sync.ts`). Each second of video is appended to a file in the extension's storage as it arrives, so the recording is not held in memory. On Stop, the offscreen document reads that file once, rewrites the WebM container to add the duration, cue points and element sizes, so the file shows its length and can be seeked (`src/offscreen/webm-fix.ts`), and writes `<id>.webm`. Only the container changes; frames are copied byte for byte.
- **Storage.** Everything is written to the extension's origin-private file system (OPFS, `navigator.storage.getDirectory()`), `sessions/<id>/`, in the same layout as the folder. After Stop the background connects to the recording helper (`chrome.runtime.connectNative("com.record2context.host")`) and sends each file in 1 MiB chunks (base64 in JSON). The helper appends them to `<file>.r2c-part`, checks every chunk's offset, and renames the file into place when the last chunk arrives. It writes only inside `recordingsDir` from its config, refusing `..`, absolute paths and symlinks that point outside. Nothing uses `chrome.downloads`, so Chrome's download settings (and other extensions that rename downloads) do not matter. The Recordings page plays from `blob:` URLs of those files (disk-backed, not copied into memory).
- **Heartbeat.** Each time Chrome starts the extension's worker, and each time you open the popup, the extension pings the helper with its id, version and build id. The helper runs a self-test (write, read back, delete a probe file in the recordings folder) and writes both to `status.json` next to its config, with the origin Chrome passed it. `npm run verify-install` uses that to prove, without looking at Chrome, that Chrome runs this build and can write the folder.
- **Launch log.** The launcher appends a line to `launch.log` (next to `config.json`) every time Chrome starts the helper, followed by the helper's error output, so `npm run verify-install` can tell "never started" from "started and failing".
- **Log.** While a session runs, two content scripts are registered for every page load: one in the page's main world (wraps `fetch`, XHR, `history`, `console.error`) and one in the isolated world (clicks, typing, keys, the bar, the note box). The background stores the session in `chrome.storage.session`, so a service-worker restart loses nothing, and a reload while paused shows the note box again with what you typed. Events are stored with their wall-clock time and turned into video time when the report is built.

## Tests

```bash
npm run typecheck
npm test            # vitest unit tests: also the helper's protocol, chunking, path safety, the extension's host client, the installer
npm run build       # extension → dist/
```

End-to-end tests start Chromium with the built extension through Playwright, a devDependency pinned to 1.61.1: run `npm ci` and, once, `npx playwright install chromium`. They also need `ffmpeg`/`ffprobe` on the PATH, and `e2e/host.e2e.mjs` needs Google Chrome installed (`PLAYWRIGHT_PATH` can point at another `playwright/index.mjs`; `R2C_E2E_CHANNEL=chrome` runs the installed Google Chrome instead, loading the extension over CDP). Each one uses its own profile under `e2e/.out/`.

**They run headless: no window opens.** `e2e/lib.mjs` starts Chromium in Chrome's new headless mode (the `chromium` channel, i.e. the full browser, since Playwright's default headless shell cannot load extensions; branded Chrome also works headless). Recording, screenshots, the editor, the popup and the Recordings page all work there. There is no emulated viewport: tab capture records the real tab, so `launch()` resizes the window until the tab is exactly 1280×800 (headless Chrome keeps about 87 px for an invisible toolbar). To watch a run, set `R2C_E2E_HEADED=1`, for example `R2C_E2E_HEADED=1 node e2e/popup.e2e.mjs`.

**The recording helper in tests.** `launch()` installs the real helper with `host/install.mjs` into the suite's own profile: Chrome reads `<user-data-dir>/NativeMessagingHosts/`, so nothing global is touched. The helper's files go in the system temp folder (Chrome cannot start a host whose files are under `~/Documents`, where this repo usually is), and its recordings folder is `e2e/.out/folder-<suite>`. Show folder writes the path to `e2e/.out/reveal-<suite>.log` (`revealLog` in the config) instead of opening Finder. `waitForOutput()` returns the folder the helper wrote; `launch(name, { host: false })` starts without the helper.

`e2e/host.e2e.mjs` is the real-environment test: the **installed Google Chrome**, headless, a temp profile, started with a minimal environment (as from the Dock). It runs `INSTALL-FOR-AI.md`'s own command blocks (`<!-- e2e:… -->`) against temp locations (`RECORD2CONTEXT_INSTALL_DIR` / `RECORD2CONTEXT_MANIFEST_DIR`). `verify-install` must say NOT_READY with only the human's Load unpacked missing, then READY once Chrome has loaded `dist/`. Recordings must land in a folder with spaces and Thai characters in `~/Downloads`, then, after `config.json` is edited, in another in `~/Documents` (both removed afterwards). Then: helper removed (setup line, recording kept), installed again (Save to folder), Show folder, Delete, Copy for my AI.

Xvfb in Docker (`e2e/docker/`, the Playwright v1.61.1 image plus ffmpeg) gives a suite a display without opening anything on your screen (Docker must be running). No suite needs it any more; `npm run e2e:local:xvfb` compares the local suite on a real (virtual) display after changing recording, pausing or `t`, and `npm run e2e:xvfb -- <suite>` runs any other suite the same way.

```bash
node e2e/local.e2e.mjs       # local page: typing, masking, keys, network, SPA route, errors, screenshot, reload, worker restart,
                             # two Marks (long Thai note, empty note), pause alignment, nothing through Chrome's downloads,
                             # both copies identical, popup copy buttons and Show folder (through the helper)
node e2e/pauses.e2e.mjs      # t after 8 Marks on a static and an animated page, the countdown, Stop during it; every Mark's
                             # frame saved; the editor and countdown never in the video
node e2e/annotate.e2e.mjs    # Screenshot → editor → two shapes with notes and colours → Continue → countdown; a second one by its key with a pen
                             # stroke; shapes, elements, colours and both PNGs in report.json / context.md
node e2e/tab-close.e2e.mjs   # closing the recorded tab still saves everything (the Stop snapshot records why it has no data)
node e2e/data.e2e.mjs        # storage snapshots, cookie names, locale, bodies only in the private folder (none in report.json,
                             # context.md or the portable context), streaming fetch still works, old-layout recording plays,
                             # the Recordings page shows the private data (also through the helper, redacted without it)
                             # and its copy buttons hold none of it
node e2e/popup.e2e.mjs       # popup: no helper (setup line + prompt, recording kept), helper installed (folder line, waiting
                             # recording copied by itself), latest readable recording, Delete both copies
node e2e/recordings.e2e.mjs  # Recordings page: list, player from OPFS and from the folder through the helper (markers, seek, synced
                             # tabs, long URLs, annotations), Delete, Delete selected, Remove missing, helper removed, Save to folder
node e2e/host.e2e.mjs        # installed Google Chrome + the real helper installed by INSTALL-FOR-AI.md's commands (see above)
```

The local test checks that `t` still matches the video after a pause: it flashes the whole page green (at the start of a frame) before and after a Mark and finds the first video frame (by its exact timestamp) that shows each flash; both must land within one frame (33.3 ms) after their `t`. Click ripples are checked the same way: two clicks are held for 100 ms like a person's, and the first frame showing the ripple must land between 40 ms before and 120 ms after the press; the frame a player shows at `t` must show it.

`e2e/pauses.e2e.mjs` records one clip with 8 Marks (different notes and pause lengths) on a static page and on a page that repaints every frame, with a flash after each resume, plus Stop during a countdown. The animated page draws its own `Date.now()` into every frame as a row of black and white blocks and logs some of those frames as events, so the test checks, event by event, that the frame at `t` is the first one drawn at or after it. It also checks the countdown is 3-2-1 and that neither the countdown nor the Mark editor is ever in the video.


**What the E2E tests cannot do.** Chrome only allows tab capture after a real user gesture on the extension (a toolbar click or the keyboard shortcut). Playwright cannot click the toolbar, and its key presses do not reach Chrome's shortcut handling, so the tests start Chromium with `--allowlisted-extension-id=<id>`. For the same reason `Alt+Shift+S` is tested through the page-level handler, and `Alt+Shift+R` by calling the background's command handler (`self.record2contextTest.command`), not through Chrome's command. Load unpacked in a person's own Chrome profile, a Chrome started from the Dock, and macOS asking whether Chrome may use a Desktop/Documents/Downloads folder cannot be driven either. Check these by hand:

### Manual check

1. Have an AI install it with `INSTALL-FOR-AI.md` (or run `npm run build && npm run install-host -- --choose-folder default` yourself, or `--choose-folder "<folder>"`), then load `dist/` unpacked in your normal Chrome, started from the Dock. Leave "Ask where to save each file" as it is (on or off: it must not matter). `npm run verify-install` says `READY`.
2. Open any http(s) page, click the toolbar icon. The popup says **Saving to <your recordings folder>**. Click **Start recording**: the bar appears and the badge shows `REC`.
3. The bar shows `⌥⇧S` on **Screenshot** and `⌥⇧R` on **Stop**; the popup lists the same keys. Click a few things, press **Screenshot**: the editor opens on the paused frame. Draw a box in yellow and an arrow in cyan, give each a note, type a note, Enter. The countdown runs, then recording resumes. Reload, press `Alt+Shift+S` (Chrome's shortcut, which the tests cannot press), Continue without drawing. Click **Stop**. No Save dialog appears.
4. Check `<recordings folder>/<id>/` has only `<id>.webm`, `screenshot-NN.png` and `details/` at the top, `details/` has `report.json`, `AI-README.md`, `context.md` and `private-do-not-share/`, and the video plays with a duration and a working seek bar.
5. In the popup, try **Copy for my AI** (the path is in your recordings folder and exists), **Copy portable context** and **Show folder** (Finder opens the recording's folder). Open **All recordings**, open the recording, click a marker, a row and a long URL's **more**.
6. Quit Chrome completely and start it again from the Dock; record again. It still lands in the folder (nothing to allow again).
7. `npm run uninstall-host`, wait 10 s, open the popup: one line **Not set up yet — give this to your AI**; **Copy** copies the prompt naming `INSTALL-FOR-AI.md`; **Start recording** is disabled and `Alt+Shift+R` shows the popup (or the Recordings page) instead of recording. `npm run install-host`, open the popup again: Start works.
8. Change the folder to one in `~/Documents` with `npm run install-host -- --recordings-dir "<folder in ~/Documents>"` (as in `INSTALL-FOR-AI.md`, "Change the recordings folder later"; editing `config.json` by hand is undone by the next `install-host`), open the popup, record. The earlier recordings still show "In extension + folder", **Copy for my AI** names their old folder, and **Delete** removes them there. Either it lands there, or macOS asks whether Google Chrome may access Documents (allow), or the popup shows **Recordings folder problem** (and `npm run verify-install` says why).
9. Start with `Alt+Shift+R` instead of the popup (it toggles start and stop).
10. On a `chrome://` page, **Start recording** shows "This page cannot be recorded."

## Known limits

- One tab per session. Other tabs and new windows are not recorded or logged.
- `chrome://`, the Chrome Web Store and other extension pages cannot be recorded.
- The video is the tab content only. Browser UI, native dialogs and other windows are not in it.
- Clicks on elements that disappear on `mousedown` (some menus) may not fire `click`, so they are missing from the log.
- Typing is logged after 500 ms without a keystroke, before any click, key, Mark, Stop or page unload.
- Clicks in cross-origin iframes have coordinates relative to the iframe (`frame.translated: false`); a shape over an iframe can only name the iframe element.
- `t` lands on the first frame drawn at or after the event, after any number of pauses. Measured in `e2e/pauses.e2e.mjs` (8 Marks, 10 headless and 4 Xvfb runs): a full-page flash's first frame is 0-17 ms after its `t` on a static page and 2-25 ms on a page that repaints every frame (the frame it was drawn in, or the next 60 Hz frame because the video keeps about every other one), the same after every pause; each pause's cut matched the measured pause to within 1.4 ms; and about 1 event in 100 drawn within 3 ms of a frame boundary landed on the neighbouring frame (timestamps are whole ms). If frame timing is unavailable (`clockSync.source: "wall-clock"`), `t` falls back to the call times and can be one or two frames early.
- When the recorder drops a frame (rare, seen right after a resume on a static page), the next frame shows the change, up to about 70 ms after `t`.
- For the page open at Start, requests made through a `fetch` reference cached before Start appear only as `resource-timing` rows.
- The video is streamed to the extension's storage while recording; at Stop it is read into memory once to fix the container (about 22 MB per minute at 3 Mbit/s).
- Removing the extension deletes its storage, and with it every recording that was never copied to the folder.
- A helper process that is already running keeps answering until its connection has been idle for 5 s, so right after `uninstall-host` one more recording may still reach the folder.
- The helper's launcher holds the absolute path of the `node` it was installed with. If that Node is removed (for example an nvm version), the helper stops working until `npm run install-host` is run again; `npm run verify-install` reports it.
- On macOS, Chrome (and so the helper) may need permission for a recordings folder in Desktop, Documents or Downloads; the default `~/record2context-recordings` needs none. Chrome cannot start a helper whose own files are in those folders, which is why it is installed in `~/Library/Application Support/record2context/`.
- The player reads a recording through the helper only when the extension's copy is gone; such a video is read back in 512 KiB pieces into memory before it plays.
- The element under a shape is the topmost one at that point, so a box around a whole card may name a child inside it. Shapes drawn before a reload while the Mark editor is open are lost (the frame and the note are kept).
- The bar, note box and editor sit in an open shadow root. Page scripts could, in theory, reach into them.

## Third-party code

Parts of the capture code are adapted from [TraceBug](https://github.com/prashantsinghmangat/TraceBug-ai) (MIT). See `THIRD_PARTY_NOTICES`.
