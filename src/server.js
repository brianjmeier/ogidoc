import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STATIC = { "/": join(HERE, "..", "web"), "/shared/": join(HERE, "shared") };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

export function startServer(session, { port = 4747, host = "127.0.0.1" } = {}) {
  const clients = new Set();
  session.on("change", (extra) => {
    const msg = `data: ${JSON.stringify({ state: session.snapshot(), ...extra })}\n\n`;
    for (const res of clients) res.write(msg);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname === "/api/state") return json(res, session.snapshot());
      if (url.pathname === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ state: session.snapshot() })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        req.on("close", () => { clients.delete(res); clearInterval(ping); });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/edit") {
        session.edit(await body(req));
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/pass") {
        const b = await body(req);
        if (session.working) return json(res, { error: "The agent already has the pen." }, 409);
        session.pass(b);
        return json(res, { ok: true }, 202);
      }
      if (req.method === "POST" && url.pathname === "/api/undo") {
        session.undo();
        return json(res, { ok: true });
      }
      return serveStatic(url.pathname, res);
    } catch (e) {
      return json(res, { error: e.message }, 400);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE" && port !== 0) resolve(startServer(session, { port: 0, host }));
      else reject(e);
    });
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}

async function serveStatic(pathname, res) {
  const [prefix, root] = pathname.startsWith("/shared/") ? ["/shared/", STATIC["/shared/"]] : ["/", STATIC["/"]];
  const rel = normalize(pathname.slice(prefix.length) || "index.html").replace(/^(\.\.[/\\])+/, "");
  try {
    const data = await readFile(join(root, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

function json(res, obj, code = 200) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function body(req) {
  return new Promise((resolve, reject) => {
    let d = "";
    req.on("data", (c) => { d += c; });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
