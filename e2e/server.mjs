// Static server with HTTP Range support (so <video> seeking behaves like a real host) and a tiny JSON API.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".webm": "video/webm", ".png": "image/png" };

export function startServer(root, port = 0) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname.startsWith("/api/ping")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, at: Date.now() }));
      return;
    }
    if (url.pathname.startsWith("/api/fail")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    // e2e/data.e2e.mjs: bodies, streaming and binary responses.
    if (url.pathname === "/api/echo") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ got: body, marker: `RESPONSE-BODY-MARKER-${url.searchParams.get("n") ?? 0}` }));
      });
      return;
    }
    if (url.pathname === "/api/stream") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      let i = 0;
      const timer = setInterval(() => {
        res.write(`chunk-${++i}\n`);
        if (i === 5) {
          clearInterval(timer);
          res.end();
        }
      }, 150);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (url.pathname === "/api/endless") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      let i = 0;
      const timer = setInterval(() => res.write(`data: ${++i}\n\n`), 100);
      req.on("close", () => clearInterval(timer));
      return;
    }
    if (url.pathname === "/api/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`${"y".repeat(1024 * 1024)}END`);
      return;
    }
    if (url.pathname === "/api/image") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      return;
    }
    if (url.pathname === "/player.html") {
      res.writeHead(200, { "content-type": TYPES[".html"] });
      const v = encodeURIComponent(url.searchParams.get("v") ?? "video.webm");
      res.end(`<!doctype html><video src="/${v}" controls muted preload="metadata"></video>`);
      return;
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, rel);
    let st;
    try {
      st = statSync(file);
      if (st.isDirectory()) {
        file = join(file, "index.html");
        st = statSync(file);
      }
    } catch {
      // SPA fallback so pushState routes reload fine.
      file = join(root, "index.html");
      try {
        st = statSync(file);
      } catch {
        res.writeHead(404).end();
        return;
      }
    }
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": st.size });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}
