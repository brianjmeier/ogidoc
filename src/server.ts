import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { text } from "node:stream/consumers";
import { extname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import { WEB_DIR } from "./paths.ts";
import type { Session } from "./session.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

// Only a browser on this machine, on a page this server served, may drive the session:
// a turn runs an agent that edits files and runs commands. A local Host header stops DNS
// rebinding. A POST must be JSON from the same origin, and another site can only send
// JSON after a CORS preflight, which this server never grants. Any port is fine, so a
// tunnel that forwards to a different local port still works.
function trusted(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  if (!LOCAL_HOSTS.has(host.replace(/:\d+$/, ""))) return false;
  if (req.method !== "POST") return true;
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) return false;
  return (req.headers["content-type"] ?? "").startsWith("application/json");
}

export function startServer(session: Session, { port = 4747, host = "127.0.0.1" } = {}): Promise<{ server: Server; url: string }> {
  if (!existsSync(join(WEB_DIR, "index.html"))) throw new Error(`The editor isn't built yet. Run \`npm run build\` in ${join(WEB_DIR, "..", "..")}.`);
  // Each of the person's actions is one session call; the session validates the body.
  const actions: Record<string, (b: any) => unknown> = {
    "/api/edit": (b) => session.edit(b),
    "/api/comment": (b) => session.comment(b),
    "/api/reply": (b) => session.reply(b),
    "/api/resolve": (b) => session.resolve(b),
    "/api/settings": (b) => session.setSettings(b),
    "/api/undo": () => session.undo(),
  };
  const clients = new Set<ServerResponse>();
  session.on("change", (extra) => {
    const msg = `data: ${JSON.stringify({ state: session.snapshot(), ...extra })}\n\n`;
    for (const res of clients) res.write(msg);
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!trusted(req)) return json(res, { error: "Underpaint only takes requests from its own page on this machine." }, 403);
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
      if (req.method === "POST" && url.pathname === "/api/pass") {
        const b = await body(req);
        if (session.working) return json(res, { error: "The agent already has the pen." }, 409);
        session.pass(b).catch((e: Error) => console.error(`Underpaint: the turn could not finish: ${e.message}`));
        return json(res, { ok: true }, 202);
      }
      const action = req.method === "POST" ? actions[url.pathname] : undefined;
      if (action) {
        action(await body(req));
        return json(res, { ok: true });
      }
      return serveStatic(url.pathname, res);
    } catch (e) {
      return json(res, { error: (e as Error).message }, 400);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE" && port !== 0) resolve(startServer(session, { port: 0, host }));
      else reject(e);
    });
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${(server.address() as AddressInfo).port}` }));
  });
}

async function serveStatic(pathname: string, res: ServerResponse) {
  const rel = normalize(pathname.slice(1) || "index.html").replace(/^(\.\.[/\\])+/, "");
  try {
    const data = await readFile(join(WEB_DIR, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not found");
  }
}

function json(res: ServerResponse, obj: unknown, code = 200) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// Request bodies are the browser's JSON; the session validates what it uses.
async function body(req: IncomingMessage): Promise<any> {
  const d = await text(req);
  return d ? JSON.parse(d) : {};
}
