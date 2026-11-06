import { isUrl } from "./validate.js";
import { makeCode } from "./codes.js";
import { store } from "./store.js";

export function shorten(body) {
  if (!isUrl(body?.url)) return { status: 400, json: { error: "not a url" } };
  const code = makeCode();
  store.save(code, body.url);
  return { status: 201, json: { code, short: `/${code}` } };
}

export function follow(code) {
  const link = store.find(code);
  if (!link) return { status: 404, json: { error: "unknown code" } };
  store.countVisit(code);
  return { status: 302, location: link.url };
}

export function stats(code) {
  const link = store.find(code);
  if (!link) return { status: 404, json: { error: "unknown code" } };
  return { status: 200, json: { url: link.url, visits: link.visits } };
}
