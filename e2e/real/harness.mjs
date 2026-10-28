// The installed Google Chrome, headless, with a temp profile and dist/ loaded over CDP (branded Chrome ignores
// --load-extension). Chrome reads <user-data-dir>/NativeMessagingHosts, so a host installed there is seen by this profile only.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import { join } from "node:path";
import { MINIMAL_PATH } from "../../host/common.mjs";
import { DIST, EXTENSION_ID, ROOT, chromium } from "../lib.mjs";

function freePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function browserCdp(port, method, params) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  try {
    return await new Promise((resolve, reject) => {
      ws.onmessage = (m) => {
        const d = JSON.parse(m.data);
        if (d.id === 1) d.error ? reject(new Error(`${method}: ${JSON.stringify(d.error)}`)) : resolve(d.result);
      };
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
  } finally {
    ws.close();
  }
}

/** Roughly the environment of a Chrome started from the Dock: no shell profile, no nvm on PATH. */
export function minimalEnv() {
  return { HOME: os.homedir(), USER: os.userInfo().username, TMPDIR: os.tmpdir(), PATH: MINIMAL_PATH };
}

/** Starts Chrome with `profile` (no extension yet); `loadUnpacked()` then stands in for the person's Load unpacked. */
export async function launchRealChrome(profile, { env = minimalEnv() } = {}) {
  const port = await freePort();
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    env,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging", `--allowlisted-extension-id=${EXTENSION_ID}`, `--remote-debugging-port=${port}`],
  });
  return {
    ctx,
    async loadUnpacked(path = DIST) {
      const r = await browserCdp(port, "Extensions.loadUnpacked", { path });
      const find = () => ctx.serviceWorkers().find((w) => w.url().startsWith(`chrome-extension://${r.id}/`));
      let sw = find();
      for (let i = 0; i < 50 && !sw; i++) {
        await ctx.waitForEvent("serviceworker", { timeout: 2000 }).catch(() => undefined);
        sw = find();
      }
      if (!sw) throw new Error(`no service worker for ${r.id}`);
      return { id: r.id, sw };
    },
  };
}

/** The ```sh block after `<!-- e2e:<name> -->` in INSTALL-FOR-AI.md, so the test runs the guide's own commands. */
export function guideBlock(name) {
  const md = readFileSync(join(ROOT, "INSTALL-FOR-AI.md"), "utf8");
  const m = new RegExp(`<!-- e2e:${name} -->\\n\`\`\`sh\\n([\\s\\S]*?)\`\`\``).exec(md);
  if (!m) throw new Error(`INSTALL-FOR-AI.md has no e2e:${name} block`);
  return m[1];
}
