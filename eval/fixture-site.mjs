// Local fixture site for the mcp-eval contract suite.
//
// Preloaded into the stdio server with `node --import ./fixture-site.mjs ../dist/src/stdio.js`
// (see target.command in mcp.suite.yaml). Before the server loads its config, it:
// - serves eval/fixtures/site on http://127.0.0.1:3298 (loopback only), so every happy path
//   reads a local page and the suite never touches the live web;
// - points CACHE_DIR at eval/.cache (git-ignored) and empties it, so each run starts from a
//   cold cache and the goldens stay deterministic.
// The server under test is the unmodified dist/src/stdio.js.
import { readFile, stat } from "node:fs/promises";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const PORT = 3298;
const evalDir = path.dirname(fileURLToPath(import.meta.url));
const siteDir = path.join(evalDir, "fixtures", "site");
const cacheDir = path.join(evalDir, ".cache");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

if (process.env.SITE_BASE_URL !== `http://127.0.0.1:${PORT}/`) {
  process.stderr.write(`fixture-site: SITE_BASE_URL must be http://127.0.0.1:${PORT}/ for the contract suite.\n`);
  process.exit(2);
}

rmSync(cacheDir, { recursive: true, force: true });
process.env.CACHE_DIR = cacheDir;

const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`).pathname);
  const relative = pathname.endsWith("/") ? `${pathname}index.html` : pathname;
  const file = path.resolve(siteDir, `.${relative}`);
  try {
    if (request.method !== "GET" && request.method !== "HEAD") throw new Error("method");
    if (!file.startsWith(siteDir + path.sep)) throw new Error("outside");
    if (!(await stat(file)).isFile()) throw new Error("not a file");
    // Normalise line endings so a CRLF checkout serves the same bytes as an LF one.
    const body = (await readFile(file, "utf8")).replace(/\r\n/gu, "\n");
    response.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
});
// The MCP server's stdio lifetime decides when the process ends, not this listener.
server.unref();
