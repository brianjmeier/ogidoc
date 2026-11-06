import { shorten, follow, stats } from "./links.js";
import { shortenLimit } from "./rateLimit.js";

// method + path → the handler that answers it.
export function route(method, url, body, ip) {
  if (method === "POST" && url === "/links") {
    if (!shortenLimit.allow(ip)) return { status: 429, json: { error: "slow down" } };
    return shorten(body);
  }
  const m = url.match(/^\/([\w-]+)(\/stats)?$/);
  if (method === "GET" && m) return m[2] ? stats(m[1]) : follow(m[1]);
  return { status: 404, json: { error: "not found" } };
}
