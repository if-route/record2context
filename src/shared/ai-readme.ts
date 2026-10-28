import { fmtVideoTime } from "./format";
import type { Report } from "./report";

/** AI-README.md: how to read this session folder, for any AI. Generated per session so names and sizes are real. */
export function buildAiReadme(report: Report, sessionId: string): string {
  const video = report.video?.file ?? `${sessionId}.webm`;
  const vw = report.video?.width ?? 0;
  const vh = report.video?.height ?? 0;
  const { width: cw, height: ch } = report.viewport;
  const shots = report.screenshots ?? [];
  const marks = report.marks ?? [];
  const missing = report.video ? "" : ` (missing: ${report.videoError ?? "no video"})`;
  const tick = "`";
  const images = shots.length
    ? `${shots.length} image(s): ${shots.map((s) => `${tick}${s.annotatedFile ?? s.file}${tick} at t=${s.t}${s.mark ? ` (Screenshot ${s.mark})` : ""}${s.annotatedFile ? ` (plain frame: ${tick}${s.file}${tick})` : ""}`).join(", ")}.`
    : "Images (none in this session).";
  return `# record2context recording ${sessionId}

A recording of what a person did in one Chrome tab, made by the record2context Chrome extension. Nothing here was written by an AI; the person may add their own question when they share it.

## Files

This file is \`details/AI-README.md\`. Every path below, and every path in report.json, is relative to the recording folder (the folder that holds \`details/\`).

| File | What it is |
|---|---|
| \`${video}\` | Video of the tab, ${vw}x${vh}, ${fmtVideoTime(report.durationMs)} long${missing}. A cursor dot and a red ring at each click are drawn into it. |
| \`screenshot-NN.png\` (older recordings: \`mark-NN.png\`) | ${images} Screenshot N is the frame the person captured (mark N in report.json), with their shapes drawn on when they drew any (then the plain frame is in \`details/screenshots/\`). These and the video are what the person uploads when they share the recording. |
| \`details/report.json\` | The full log: every event and every network row, ordered by \`t\`. The source of truth. |
| \`details/context.md\` | A compact digest of report.json for pasting into a chat or an issue comment: actions with the requests after each, marks, errors, a replay list, grouped network. |
| \`details/screenshots/\` | Plain frames of Screenshots the person drew on. |
| \`details/private-do-not-share/\` | Raw page data for local use only: \`storage/\` (localStorage, sessionStorage and cookie names at Start, each Screenshot and Stop, unredacted) and \`bodies/\` (request and response bodies of fetch/XHR calls, one file per call, named by the \`bodyId\` of its network event). report.json and context.md never contain anything from it. Read it when a question needs it; do not paste it anywhere public. |
| \`details/AI-README.md\` | This file. |

## Time

- Every \`t\` is milliseconds on the video clock: 0 is the first frame, and paused time is left out, so \`t\` is always a position in \`${video}\`.
- Frame at an event: \`ffmpeg -ss <t/1000> -i ${video} -frames:v 1 frame.png\` (e.g. t=12345 → \`-ss 12.345\`). This gives the first frame the page drew at or after the event${report.clockSync?.source === "video-frames" ? "" : " (approximately: this session's clock could not be lined up with the video's frames, so it may be one or two frames early)"}. The page's reaction to the event (a new view, a loaded list) can take longer than that; look a few frames later for it.
- The clock was lined up with the video's own frames: t=0, every pause and the picture lag were measured, not assumed. \`report.clockSync\` lists each correction. Measured accuracy: the same after any number of pauses (tested with 8); an event drawn within about 3 ms of a frame boundary (about 1 in 100) can land on the neighbouring frame, 1/30 s away.
- \`report.startedAt\` is the wall-clock time of t=0.

## Screenshots and pauses

- The person pressed **Screenshot** to point at a moment (${marks.length} in this session). The video paused there, the tab was captured, and they could draw on it and type a note (any language, may be empty), then continued. report.json calls each one a mark: a \`mark\` event and an entry in \`marks\`.
- \`mark\` events: \`{ n, t, note, screenshot?, annotatedScreenshot? }\`. \`pause\` events: \`{ t, pausedMs }\`, at the same \`t\`. The video has no frames for the paused time.
- The capture was taken while paused: \`screenshot\` is that frame (the page as the person saw it at the mark, without the recorder's bar), and the screenshot event with \`mark: n\` holds any shapes they drew on it.
- The moment the person pressed Screenshot is the last frame before the mark's \`t\`; the frame at \`t\` comes after the pause.
- Events with \`duringPause: true\` (network, console, route, ...) happened while paused; their \`t\` is the pause point.
- Typing in the Screenshot note box is never logged as page input.

## Screenshots and shapes

- A screenshot event (and \`report.screenshots[]\`) may have \`annotations\`: one per shape the person drew, numbered like the badge (1, 2, 3...) next to it in the image: \`{ n, shape: box|arrow|pen, color, hex, geometry: { image, css }, note, element? }\`.
- \`geometry.image\` is in PNG pixels, \`geometry.css\` in page CSS pixels at capture (\`css = image * viewport.width / imageWidth\`). A box is \`{ x, y, width, height }\`, an arrow \`{ from, to }\` (\`to\` is the tip), a pen stroke \`{ points, bbox }\`.
- \`note\` is what the person wrote for that shape (may be empty).
- \`element\` (box and arrow only) is what was on the live page under the box's centre or the arrow's tip when the shape was drawn: \`tag\`, \`label\`, \`selector\`, \`testId\`, \`role\`, \`text\` (up to 80 chars), \`bbox\` (CSS px) and computed \`style\` (\`color\`, \`backgroundColor\`, \`inheritedBackground\` when its own is transparent, \`fontSize\`, \`fontWeight\`, \`display\`, \`visibility\`). It is the topmost element there, so a shape around a whole card may name a child inside it.

## Where things are on screen

\`bbox\` and \`point\` on click events are CSS pixels in the top-level viewport (\`event.viewport\`; this session started at ${cw}x${ch}, devicePixelRatio ${report.devicePixelRatio}). To map to video pixels:

\`\`\`
scale  = min(videoWidth / viewport.width, videoHeight / viewport.height)
offset = ((videoWidth - viewport.width * scale) / 2, (videoHeight - viewport.height * scale) / 2)
videoX = offset.x + x * scale,  videoY = offset.y + y * scale
\`\`\`

Screenshot pixels: \`css * imageWidth / viewport.width\` (from the screenshot event).

## Events in report.json

\`page_load\` (navigationType navigate/reload/back_forward, initial = open at start), \`route_change\` (from, to, via), \`click\` (label, labelSource, tag, role, testId, selector, bbox, point, href), \`input\` (label, inputType, value, valueLength, masked, truncated; \`t\` is the last keystroke), \`key\` (Enter/Escape/Tab with modifiers), \`network\` (method, url, status, durationMs, source, bodyId when its bodies were kept; \`t\` is the request start; status 0 = failed or hidden), \`console_error\`, \`screenshot\` (file, viewport, imageWidth, imageHeight, annotated, annotatedFile, mark, annotations), \`mark\`, \`pause\`. Events from iframes carry \`frame\`.

## Page state and environment

- \`report.browser\` has the user agent, OS, \`language\`, \`languages\`, \`locale\` (number and date formatting), \`timeZone\` and \`utcOffsetMinutes\` at Start.
- \`report.storage\`: one snapshot at Start, at each Screenshot (label \`mark-N\`, \`t\` = the mark's) and at Stop: \`local\` and \`session\` (\`keys\` and \`entries\` of \`{ key, value, length, redacted?, truncated? }\`), \`cookieNames\` (cookie values are never read), \`privateFile\` (the same snapshot unredacted), or \`error\` when the page could not be read.
- \`report.privateData\` says what is in \`details/private-do-not-share/\`: the storage files, and how many bodies were kept or skipped (with the reasons). A network event without \`bodyId\` had no body kept.

## What is masked

- Password and email fields, and fields whose name, label, placeholder or autocomplete looks sensitive (password, token, secret, API key, one-time code, card number, CVV, PIN, email, username, ...) are logged as \`[MASKED]\` with their real length.
- Email addresses anywhere else (URLs, typed values, labels, page titles, console errors, text under a shape) are \`[EMAIL]\`. The person's own Screenshot and shape notes are kept as they wrote them, so an address they typed there stays.
- Sensitive URL query values are \`[REDACTED]\`. JWTs and Bearer/Basic tokens are removed from console messages and notes.
- Storage values in report.json are redacted by key name (token, auth, session, secret, password, pass, key, jwt, cookie, ...), per field inside JSON (also JSON stored as a string), and by shape (JWTs, Bearer tokens, known key prefixes, 16+ character strings mixing letters and digits such as ids and UUIDs, emails), then cut to 120 characters. The same shape rules apply to labels, console errors and typed values. Request headers and cookie values are never recorded.
- Request and response bodies are only in \`details/private-do-not-share/bodies/\` (text types, at most 256 KiB each); they are not redacted there.
- The video shows whatever was on screen, including anything typed.
`;
}
