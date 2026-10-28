# Verify a record2context installation: instructions for an AI agent

You are the **independent verifier**. Another agent (or an earlier pass of you) installed record2context by following `INSTALL-FOR-AI.md`. Your job is to prove the installation is complete and works from the real Chrome, or to say exactly what is wrong and who has to fix it. **Do not fix anything and do not ask the person anything.** Report only.

Run commands from the repository root (the folder that contains this file); below, `<REPO>` is its absolute path. The only things you may write are what the verify script writes itself (a temporary `record2context-verify-*` folder in the recordings folder, which it deletes again) and the probe file item 4 below creates and removes.

## 1. Run the mechanical checks

```sh
npm run verify-install
```

It prints one JSON object (exit code 0 = `READY`, 1 = `NOT_READY`). Each entry in `checks` has `id`, `ok`, `required`, `evidence`, and when it failed `owner` (`installer` or `human`) and `fix`. Keep the whole output; you need it for step 3. If the installer used a browser other than Chrome, add `-- --browser chromium` (or `edge`, `brave`).

What it covers: Node version; `dist/` built from this repo and newer than its source; the host manifest (name, `type: stdio`, absolute executable `path`, `allowed_origins` exactly the extension id from the manifest key); the launcher's `node`, helper and config paths; the installed helper identical to `host/record2context-host.mjs`; the helper not installed in Desktop/Documents/Downloads; `recordingsDir` absolute and existing; the helper answering with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` (as when Chrome is started from the Dock); a write → list → read → delete round trip through the helper with a space and Thai characters in the path; the heartbeat written when **Chrome** started the helper (origin, extension id), newer than the install, from the build in `dist/`; when there is no heartbeat, the launch log tells "Chrome never started the helper" (the person's step) from "Chrome started it and it failed" (the installer's, with the helper's error text; see the state table in `INSTALL-FOR-AI.md` step 6); Chrome's own self-test write in the configured folder; the folder "Copy for my AI" will name.

## 2. Judgement checks: do these by hand, without the script

The script is code in the same repository as the install. Re-derive the key facts independently, using only the shell and the files on disk. For each item, record what you ran and what you saw.

1. **Extension id from the key.** Compute it yourself and compare it with the host manifest's `allowed_origins` and with `extensionId` in `dist/build-info.json`:
   ```sh
   node -e 'const k=require("./static/manifest.json").key;const h=require("crypto").createHash("sha256").update(Buffer.from(k,"base64")).digest("hex").slice(0,32);console.log([...h].map(c=>String.fromCharCode(97+parseInt(c,16))).join(""))'
   ```
   It must print `cmjkjjacbelgggcnknblelhepfmahgon`, and `dist/manifest.json` must contain the same `key` as `static/manifest.json`.
2. **Host manifest, read it yourself.** macOS Chrome: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.record2context.host.json` (Chromium: `~/Library/Application Support/Chromium/...`, Edge: `~/Library/Application Support/Microsoft Edge/...`, Brave: `~/Library/Application Support/BraveSoftware/Brave-Browser/...`; Linux: `~/.config/google-chrome/NativeMessagingHosts/`; Windows: the path in registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.record2context.host`). Check it is valid JSON, `name` is `com.record2context.host`, `path` is absolute and exists, and `allowed_origins` is `["chrome-extension://<id from item 1>/"]` with the trailing slash. `cat` the launcher at `path`: it must `exec` an absolute `node`, and that `node` must run: `"<node path>" --version` prints v20 or newer.
3. **The helper starts with an empty environment.** Start it as Chrome would (origin as the argument, no environment apart from `R2C_CALLER`, which only keeps this start out of the launch log) and send a ping:
   ```sh
   node -e '
   const {spawn}=require("child_process");const [l,o]=process.argv.slice(1);
   const c=spawn(l,[o],{env:{R2C_CALLER:"manual-check"}});const b=Buffer.from(JSON.stringify({id:1,op:"ping"}));const h=Buffer.alloc(4);h.writeUInt32LE(b.length);
   let out=Buffer.alloc(0);c.stdout.on("data",d=>{out=Buffer.concat([out,d]);if(out.length>=4&&out.length>=4+out.readUInt32LE(0)){console.log(out.subarray(4).toString());c.stdin.end();}});
   c.stderr.on("data",d=>process.stderr.write(d));c.on("exit",code=>{if(!out.length)console.log("exited",code,"without a reply")});
   c.stdin.write(Buffer.concat([h,b]));' "<launcher path>" "chrome-extension://<id>/"
   ```
   The reply must have `"ok":true`, `"dirOk":true` and `dir` equal to `recordingsDir` from the config, and `hostVersion` equal to `HOST_VERSION` in `host/record2context-host.mjs`.
4. **The recordings folder.** Read `config.json` (its path is in the launcher). `recordingsDir` exists and is a folder, and `folder.chosen` (the person's answer, recorded at step 0) is either `default` or that same folder. Write and remove a file there yourself (`touch "<dir>/.verify-$$" && rm "<dir>/.verify-$$"`). If it lies in `~/Desktop`, `~/Documents` or `~/Downloads` on macOS, item 5's self-test is the deciding evidence, because macOS may let your shell write there but not Chrome.
5. **The heartbeat proves Chrome → extension → helper → disk.** Read `status.json` next to `config.json`. `lastHeartbeat.origin` must be `chrome-extension://<id>/` (only Chrome passes that), and `lastHeartbeat.buildId` must equal `buildId` in `dist/build-info.json` (Chrome runs this very build). `lastHeartbeat.at` must be later than the modification time of the host manifest, the launcher, the helper file and `config.json`. Compare both in UTC: `lastHeartbeat.at` ends in `Z` (UTC), so print the file times in UTC too, with `TZ=UTC ls -l -D '%FT%TZ' <files>` (macOS) or `TZ=UTC stat -c '%y' <files>` (Linux). Plain `ls -l` prints local time without a zone and gives the wrong answer anywhere but UTC. `selfTest.ok` must be `true`, with `selfTest.dir` equal to the configured folder. If there is no `lastHeartbeat`, read `launch.log` next to `config.json`: no `launch origin=` line means Chrome never started the helper (the extension is not loaded yet; owner: human, step 5 of INSTALL-FOR-AI.md); such lines mean Chrome started it and it failed, and the lines after the last one are its error output (owner: installer).
6. **"Not set up yet" prompt and "Copy for my AI".** `dist/build-info.json` → `repo` + `/INSTALL-FOR-AI.md` must exist; that is the file the extension's setup prompt names. If `status.json` has `lastSave`, its `dir` must exist and contain `details/report.json`, `details/AI-README.md` and `details/context.md` (a recording saved by an older version has them at the top instead): that absolute folder is what "Copy for my AI" gives an AI. If `lastSave` is missing (nothing recorded yet), that is fine. Note it, but it does not block READY.
7. **Plausibility.** Look for anything the checks would not catch: a second host manifest with the same name under another browser's folder pointing somewhere else, a leftover `com.qa_recorder.host.json` (the earlier name; step 4 removes it once the new helper works), `RECORD2CONTEXT_*` variables set in the shell profile (`grep -r RECORD2CONTEXT_ ~/.zshrc ~/.bashrc ~/.profile 2>/dev/null`), or a `roots.json` next to `config.json` that does not list the folder in `recordingsDir` (it is created by the helper on first use; missing before Chrome has used the helper is fine).

## 3. Report

Return exactly one JSON object, nothing else around it:

```json
{
  "verdict": "READY",
  "script": { "verdict": "READY", "failedChecks": [] },
  "failures": [
    { "id": "heartbeat-build", "owner": "human", "evidence": "status.json buildId 20261028T0612-ab12cd, dist/build-info.json 20261028T0655-ef34aa", "fix": "Human step: in chrome://extensions, click the round-arrow reload button on record2context once." }
  ],
  "notes": ["nothing recorded yet, so lastSave was not checked"]
}
```

- `verdict` is `READY` only when the script's verdict is `READY` **and** none of your items 1-7 found a blocking problem. Otherwise `NOT_READY`.
- Every failure has `id` (the script's check id, or `manual-1` … `manual-7` for your items), `owner`, `evidence` (what you ran and saw, with paths and values), and `fix`.
- `owner` is `human` only for what a person must do in Chrome or macOS (load or reload the extension, click its icon, allow folder access in System Settings). Everything that can be done from a shell is `installer`. While any failure is the installer's, mark the person's steps `installer` too, with "fix the installer failures first" (the script does the same and keeps the person's step in `deferredHumanStep`): the person is only asked when nothing else is wrong.
- Write `fix` as one instruction. For a `human` fix, state what the person must do in Chrome or macOS as plain facts (with absolute paths); the installer tells the person in its own words.
