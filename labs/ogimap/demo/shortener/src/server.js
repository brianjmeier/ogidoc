import { createServer } from "node:http";
import { route } from "./routes.js";

// One HTTP server; every request goes through the router.
export const server = createServer(async (req, res) => {
  const body = req.method === "POST" ? await readJson(req) : undefined;
  const { status, json, location } = route(req.method, req.url, body);
  res.writeHead(status, { "content-type": "application/json", ...(location && { location }) });
  res.end(JSON.stringify(json ?? {}));
});

async function readJson(req) {
  let text = "";
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text); } catch { return {}; }
}

if (import.meta.url === `file://${process.argv[1]}`) server.listen(3000, () => console.log("http://localhost:3000"));
