import { build } from "esbuild";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoExtensionId } from "./host/common.mjs";

const repo = dirname(fileURLToPath(import.meta.url));
const dist = join(repo, "dist");
const watch = process.argv.includes("--watch");
// The heartbeat carries this id, so a verifier can tell whether Chrome runs this very build.
const buildId = `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
cpSync(join(repo, "static"), dist, { recursive: true });
writeFileSync(join(dist, "build-info.json"), `${JSON.stringify({ buildId, repo, extensionId: repoExtensionId(), builtAt: new Date().toISOString() }, null, 2)}\n`);

await build({
  entryPoints: {
    background: join(repo, "src/background/index.ts"),
    content: join(repo, "src/content/index.ts"),
    main: join(repo, "src/main/index.ts"),
    offscreen: join(repo, "src/offscreen/index.ts"),
    popup: join(repo, "src/popup/index.ts"),
    recordings: join(repo, "src/recordings/index.ts"),
  },
  outdir: dist,
  bundle: true,
  format: "iife",
  target: "chrome127",
  sourcemap: watch ? "inline" : false,
  minify: false,
  legalComments: "inline",
  logLevel: "info",
  define: { __R2C_REPO__: JSON.stringify(repo), __R2C_BUILD__: JSON.stringify(buildId) },
});
