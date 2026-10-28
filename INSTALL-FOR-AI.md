# Install record2context: instructions for an AI agent

You are an AI agent with a shell on the person's computer, asked to install or set up record2context. Do everything yourself except the few things only a person can do (marked **Human step**). This file gives you facts and commands, not messages: talk to the person in your own words, in their language, and answer their questions however suits them. Every step can be run again safely.

**Ground rules**

- **What you need from the person:** one decision, where recordings are kept (step 0). Get it once, at the start. Everything else you can find out from the shell; do not ask.
- **What the person must do:** load the extension in Chrome once (step 5), and allow macOS access prompts if they appear. Tell them when it is time and what to do. Then wait for the proof on disk (the heartbeat), not for their reply.
- Run every command from the repository root, the folder that contains this file. Below, `<REPO>` means its absolute path.
- Do not finish until the verify loop in step 6 says `READY`, or until 5 rounds have failed (then report as step 6 says).
- Never install anything inside `~/Desktop`, `~/Documents` or `~/Downloads` except the repository itself (see step 4).

## 0. The one decision: where recordings are kept

Facts to work with:

- The default is `~/record2context-recordings`. A folder directly in the home folder never triggers a macOS permission prompt.
- **An existing install already has a folder.** If `~/Library/Application Support/record2context/config.json` exists, or the earlier name's `~/Library/Application Support/QA Recorder/config.json` (Linux: `~/.local/share/record2context/` or `~/.local/share/qa-recorder/`), its `recordingsDir` is the folder in use. The installer keeps it unless it is given another one, and recordings already there stay where they are.
- Any other folder works. Use the person's exact spelling (spaces and non-English characters included) and make it absolute (`~` → the home folder).
- A folder in Desktop, Documents or Downloads works too, but on macOS Chrome may need the person's permission for it. Step 5 and the verify loop cover that.

Record the answer as soon as you have it, with the literal absolute path in the command itself (many agent tools start every command in a fresh shell, so a variable set earlier is gone by step 4). `default` keeps the folder already in use, else `~/record2context-recordings`:

<!-- e2e:choose -->
```sh
npm run install-host -- --choose-folder "<absolute folder, or default>"
```

It only writes the choice into `config.json` (step 4 creates the folder and installs). Run it again if the person changes their mind. The verifier's `folder-choice` check fails when the installed folder differs from the recorded choice.

## What you are installing

record2context is a Chrome extension that records a tab. It keeps each recording in its own storage and then hands the files to a small **helper program**, which writes them to a normal folder (the *recordings folder*). The helper is a Chrome native messaging host: Chrome starts it on demand, and no server or background process runs.

| Piece | Where (macOS) | Who makes it |
|---|---|---|
| Extension | `<REPO>/dist/`, loaded into Chrome with **Load unpacked** | you build it, the person loads it once |
| Helper program | `~/Library/Application Support/record2context/record2context-host.mjs` (copied from `<REPO>/host/`) | `npm run install-host` |
| Launcher Chrome runs | `~/Library/Application Support/record2context/record2context-host` (absolute path of `node` inside) | `npm run install-host` |
| Config | `~/Library/Application Support/record2context/config.json`: `{ "recordingsDir": "/absolute/path" }` | `npm run install-host`; you may edit it |
| Status / heartbeat | `~/Library/Application Support/record2context/status.json` | the helper, when Chrome starts it |
| Launch log | `~/Library/Application Support/record2context/launch.log`: one line per start by Chrome, then the helper's error output | the launcher, when Chrome starts it |
| Host manifest | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.record2context.host.json` | `npm run install-host` |
| Recordings | `<recordingsDir>/<YYYY-MM-DD_HHmmss>_<host>/` | the helper, after each recording |

The extension's id is fixed by the `key` in `static/manifest.json`: `cmjkjjacbelgggcnknblelhepfmahgon` on every machine. The host manifest allows only that id.

Linux: install dir `~/.local/share/record2context/`, manifest in `~/.config/google-chrome/NativeMessagingHosts/`. Windows: install dir `%LOCALAPPDATA%\record2context\`, the launcher is `record2context-host.cmd`, and the manifest sits in the install dir with its path registered under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.record2context.host`. `npm run install-host` does all of this on each OS. Only macOS has been tested.

## 1. Check the prerequisites

<!-- e2e:prereq -->
```sh
node --version
npm --version
```

- `node` must print `v20` or newer. If it is missing or older, install the current LTS from https://nodejs.org or with Homebrew (`brew install node`).
- **The helper runs with the exact `node` you run the installer with**: the launcher stores its absolute path. Step 4 prints it (`node  <path> (vNN)`). Tell the person which Node that is, and that removing or uninstalling that Node version (for example with nvm, fnm or volta) stops recordings reaching the folder until step 4 is run again. Step 6 catches it if it happens.
- Google Chrome must be installed: `ls "/Applications/Google Chrome.app"` (macOS). For Chromium, Edge or Brave, see step 4.

## 2. Build the extension

<!-- e2e:deps -->
```sh
npm ci
```

<!-- e2e:build -->
```sh
npm run build
```

`dist/` now holds the extension and `dist/build-info.json` its build id. Each build gets a new id; the verifier compares it with the id the running extension reports.

## 3. Upgrading from QA Recorder (the earlier name)

Nothing extra to run: step 4 handles it.

- It carries `recordingsDir` and `roots.json` over from `~/Library/Application Support/QA Recorder/` (unless the recorded choice names another folder; the old folder then stays readable and deletable).
- Once the new helper passes its self-check, it removes `com.qa_recorder.host.json` from every browser's NativeMessagingHosts folder, and the old helper's own files. The old folder is removed only if nothing else is left in it. Recordings are never deleted.
- The extension id did not change. If the old extension is loaded from this same `dist/` folder, a reload in `chrome://extensions` is all the person needs, and its recordings stay. If it was loaded from another folder, the person removes it and loads this `dist/` (step 5). Removing an extension deletes the recordings kept only inside it: **Save to folder** on its **All recordings** page keeps them first.

## 4. Install the helper

<!-- e2e:install -->
```sh
npm run install-host
```

It prints every path it wrote, the `node` it uses, what it replaced from an earlier install, and ends with `host self-check  OK` after starting the helper the way Chrome does. A non-zero exit code means failure: read the message, fix, and run it again.

- Other browsers: add `--browser chromium`, `--browser edge`, `--browser brave` or `--browser all` (each `--browser` adds one host manifest).
- `--json` prints the same as JSON.
- It installs into the folder recorded in step 0. Running it again updates the helper and keeps that folder; `--recordings-dir "<absolute folder>"` changes it (and the recorded choice).
- The helper must not live in Desktop, Documents or Downloads (Chrome then cannot start it), which is why `--install-dir` is left at its default.

## 5. Human step: load the extension in Chrome (once)

Skip this step if `npm run verify-install` already shows the `heartbeat` check as `ok`.

What the person does, in Google Chrome:

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. If an older **QA Recorder** or **record2context** is listed: when it was loaded from `<REPO>/dist`, its round-arrow reload button is enough and its recordings stay (then skip to 4). One loaded from another folder is removed (see step 3 about recordings kept only inside it).
3. Click **Load unpacked** and choose the folder `<REPO>/dist` (give them the absolute path; in the macOS file dialog **Cmd+Shift+G** accepts a typed path).
4. If macOS asks whether **Google Chrome** may access files in a folder, allow it. It can ask as early as Load unpacked when `<REPO>` is inside Documents, Desktop or Downloads, and again for a recordings folder there.
5. Pin the extension (puzzle-piece icon next to the address bar) and click the record2context icon once.

The verify script's `fix` text for the `heartbeat` check states the same, with the absolute path filled in. Then wait for the heartbeat, which appears as soon as Chrome runs the extension. The person does not need to reply:

<!-- e2e:wait -->
```sh
npm run verify-install -- --wait-heartbeat 600
```

It checks every 3 seconds and returns as soon as the heartbeat checks pass, or after 600 seconds. On timeout, remind the person once and wait once more; if it times out again, go to step 6 with what you have.

## 6. Verify loop (required): an independent check, then fix, until READY

Have the installation checked by a reviewer that did not do the install:

- **If your tool can start a separate agent** (a subagent, a second session, a delegated task), have it follow `<REPO>/VERIFY-FOR-AI.md` exactly, fix nothing, and return the JSON verdict that file asks for.
- **Otherwise** do the check yourself in a fresh pass: run `npm run verify-install`, then work through `VERIFY-FOR-AI.md` as if someone else had done the install. Re-read every file from disk and trust nothing you remember from steps 1-5.

Then loop, without asking the person anything:

1. Verdict `READY` → go to step 7.
2. For each failure with `"owner": "installer"`: do what its `fix` says (usually re-run step 2 or 4, or correct `config.json`).
3. For each failure with `"owner": "human"`: its `fix` says what the person must do. Tell them, then run `npm run verify-install -- --wait-heartbeat 600` instead of asking whether they did it.
4. Verify again with the same reviewer (or a fresh pass). That is one round.

After 5 rounds without `READY`, tell the person briefly what still fails, and include the last verdict's `failures` list (check id, evidence, fix) so a developer can take over.

### What the heartbeat check sees

The launcher logs every start by Chrome; starts by the installer, the verifier and the manual check in `VERIFY-FOR-AI.md` are not logged (they set `R2C_CALLER`). So the files tell the states apart:

| `status.json` | `launch.log` | `heartbeat` check | Means | Owner |
|---|---|---|---|---|
| missing | missing | `state: never-launched` | Normal right after step 4, before the person loads the extension. Later: the extension is not loaded, or an old build with another id is (Chrome only starts the helper for the allowed id). | human (step 5) |
| no `lastHeartbeat` | has `launch origin=…` lines | `state: launched-no-heartbeat` | Chrome starts the helper but it fails. `evidence.launchLog.stderrAfterLastLaunch` holds its error output. | installer |
| has `lastHeartbeat` | a later `launch` line followed by error output | `state: launched-failing-since-heartbeat` | It worked once, then broke when Chrome started it again. The error text is in the evidence. | installer |
| has `lastHeartbeat` | otherwise | `state: heartbeat` | Chrome → extension → helper works. The other heartbeat checks say whether it is fresh, from this build, and could write the folder. | |

## 7. Tell the person it is ready

Facts the person needs, in your own words:

- Where recordings are saved (`recordingsDir`), and which `node` the helper uses (step 1).
- To record: open the page, click the record2context icon, then **Start recording** (or Alt+Shift+R). **Screenshot** (Alt+Shift+S) points at a moment (draw on it, add a note); **Stop** in the bar at the bottom ends it.
- To give a recording to an AI: the icon, then **Copy for my AI**, and paste it into the chat. **Copy portable context** is the text for an AI that cannot read their files, or for an issue comment. **Show folder** opens the recording in Finder.
- In each recording folder, the files at the top (the video and the screenshot-NN.png images) are what to attach when sharing. `details/` holds the logs; `details/private-do-not-share/` holds raw page data (storage values, request and response bodies) and is never meant to be shared.

## Change the recordings folder later

Either run step 4 with the new folder, the literal absolute path in the command:

<!-- e2e:change-folder -->
```sh
npm run install-host -- --recordings-dir "<new absolute folder>"
```

…or edit `config.json`: set both `"recordingsDir"` and `"folder": { "chosen": … }` to the same absolute path (or one starting with `~/`), and create the folder. The helper reads the config every time Chrome starts it, so nothing else needs to change and the next recording goes to the new folder. **Existing recordings stay where they were saved.** The extension keeps showing, opening, copying the path of and deleting each one at its own folder. The helper remembers every recordings folder it has used (`roots.json` next to `config.json`, kept by uninstall, removed by `--purge`) and reads or deletes only directly inside those, while it writes only into the current one. Do not delete `roots.json`: the extension could then no longer delete recordings in the old folders. Then run the verify loop: its `chrome-wrote-folder` check asks for one click on the icon, so that Chrome itself proves it can write the new folder.

## Uninstall

<!-- e2e:uninstall -->
```sh
npm run uninstall-host
```

It removes the host manifest, the launcher, the helper copy, `status.json` and the launch log. `config.json` stays (add `-- --purge` to remove it too). Recordings are never deleted. Add the same `--browser` options you installed with. **Human step:** the person removes record2context in `chrome://extensions`; that deletes the copies kept inside Chrome, and the recordings folder stays.

## Troubleshooting (by verify check id)

| Check | Means | Fix (owner) |
|---|---|---|
| `node` | Node.js missing or older than 20 | install Node 20+ (installer) |
| `dist-built`, `dist-current` | `dist/` missing, from another repo, or older than the source | `npm run build`, then the person reloads the extension (installer, then human) |
| `install-guide` | the build points the "Not set up yet" prompt at a repo without this file | rebuild from this repo (installer) |
| `host-manifest`, `launcher`, `host-current` | host manifest missing or wrong, `node` gone, installed helper outdated | re-run step 4 (installer) |
| `host-location` | the helper is installed in Desktop/Documents/Downloads | re-run step 4 without `--install-dir` (installer) |
| `config` | `recordingsDir` not absolute or the folder does not exist | fix `config.json` or re-run step 4 (installer) |
| `folder-choice` | no folder choice recorded, or `recordingsDir` differs from it | step 0's `--choose-folder`, then step 4 (installer) |
| `minimal-env-run` | the helper does not start with Chrome's minimal environment | re-run step 4; read `error` (installer) |
| `host-roundtrip` | writing, reading or deleting through the helper failed | folder permissions; re-run step 4 (installer) |
| `heartbeat` | see the state table in step 6 | step 5 (human), or fix the helper (installer) |
| `heartbeat-fresh` | the install changed after Chrome last started the helper | one click on the record2context icon (human) |
| `heartbeat-build` | Chrome runs a different build than `dist/` | reload record2context in `chrome://extensions`; if it still differs, step 5 with this `dist/` (human) |
| `config-test-keys` | `config.json` holds the test-only `revealLog` key | remove it (installer) |
| `chrome-wrote-folder` | Chrome's helper could not write the recordings folder (often macOS privacy for Desktop/Documents/Downloads) | the person allows it in System Settings › Privacy & Security › Files and Folders › Google Chrome, then clicks the icon once (human) |

In the extension, a missing or broken helper shows as one line in the popup and on the Recordings page ("Not set up yet — give this to your AI" or "Recordings folder problem — give this to your AI") with a **Copy** button. It copies a short prompt that points the person's AI at this file. **Start recording (and Alt+Shift+R) stays blocked until the helper answers.** A recording whose copy failed after it started stays in the extension, which copies it to the folder by itself the next time the helper answers (or via **Save to folder** on the Recordings page).

## Reference

**Helper protocol** (Chrome native messaging: 4-byte little-endian length + UTF-8 JSON; each request has an `id`, which the reply echoes along with `ok`, and `error`/`code` when `ok` is false):

| op | request | reply |
|---|---|---|
| `ping` | optional `heartbeat: { extensionId, extensionVersion, buildId, reason }` | `hostVersion`, `protocol`, `dir`, `dirOk`, `dirError?`, `configFile`, `statusFile`; runs the self-test; a heartbeat is written to `status.json` |
| `write` | `session`, `path` (inside the session, `/`-separated), `offset`, `data` (base64), `done` | `size`; bytes are appended to `<file>.r2c-part`, `offset` must equal its current size, `done` renames it into place |
| `finish` | `session`, `files` | `dir` (absolute session folder); records `lastSave` |
| `list` | optional `session`, `dir` | without: `dir`, `sessions` (folders with a `details/report.json` or `report.json`); with: `exists`, `files` |
| `exists` | `dirs` (recorded session folders) | `found` { dir: has a report }, `refused` { dir: reason } |
| `read` | `session`, `path`, `offset`, `length`, optional `dir` | `data` (base64, at most 512 KiB), `size`, `eof` |
| `delete` | `session`, optional `dir` | `existed` |
| `reveal` | optional `session`, `dir` | opens the folder in Finder / Explorer |
| `selftest` | | writes, reads back and deletes a probe file in the recordings folder |

The helper writes only inside the current `recordingsDir`: a session is a single folder name, paths may not be absolute or contain `..`, symlinks pointing outside are refused (also a symlinked `.r2c-part`), and folders are created one level at a time after each is checked. `dir` (for reading and deleting a recording saved earlier) must be `<a folder listed in roots.json>/<session>`. Chrome passes the caller's origin as the helper's first argument, and the helper records it in the heartbeat.

**status.json:** `lastHeartbeat` { `at`, `hostVersion`, `origin`, `extensionId`, `extensionVersion`, `buildId`, `reason` (`worker-start` when Chrome starts the extension, `popup` when the person opens it, `start` at Start recording) }, `selfTest` { `at`, `ok`, `dir`, `error?` }, `lastSave` { `at`, `session`, `dir`, `files` }.

**launch.log:** `<UTC time> launch origin=<origin>` per start by Chrome, followed by anything the helper wrote to stderr. Above 256 KiB it moves to `launch.log.1` (verify reads both).

**Test-only overrides** (the repo's E2E tests run this file's commands against temp folders with them; never set them for a real install): `RECORD2CONTEXT_INSTALL_DIR`, `RECORD2CONTEXT_MANIFEST_DIR`, `RECORD2CONTEXT_REVEAL_LOG`, `RECORD2CONTEXT_LEGACY_INSTALL_DIR`. With a custom install dir the installer never looks at the real earlier install.
