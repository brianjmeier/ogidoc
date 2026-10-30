import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.ts";
import { open } from "./support/index.ts";

function send(port: number, method: string, path: string, headers: Record<string, string>, body = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject);
    req.end(body);
  });
}

test("only the editor's own page on this machine can drive the session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ogidoc-server-"));
  const { session } = open(dir, { planFile: "p.plan", commit: false });
  const { server } = await startServer(session, { port: 0 });
  const port = (server.address() as AddressInfo).port;
  const self = `127.0.0.1:${port}`;
  const edit = JSON.stringify({ text: "hello" });
  try {
    assert.equal(await send(port, "POST", "/api/edit", { host: self, origin: `http://${self}`, "content-type": "application/json" }, edit), 200);
    assert.equal(await send(port, "POST", "/api/edit", { host: `localhost:9999`, "content-type": "application/json" }, edit), 200, "a tunnel to another local port");
    assert.equal(await send(port, "POST", "/api/pass", { host: self, origin: "https://evil.example", "content-type": "application/json" }, "{}"), 403, "another site");
    assert.equal(await send(port, "POST", "/api/pass", { host: self, "content-type": "text/plain" }, "{}"), 403, "a form post, which needs no preflight");
    assert.equal(await send(port, "GET", "/api/state", { host: `evil.example:${port}` }), 403, "DNS rebinding");
    assert.equal(session.snapshot().working, false);
    assert.equal(session.snapshot().lines[0].text, "hello");
  } finally {
    server.close();
  }
});
