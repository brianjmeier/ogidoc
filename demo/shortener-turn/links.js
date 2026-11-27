import { isUrl } from "./validate.js";
import { makeCode } from "./codes.js";
import { store } from "./store.js";

const DAY = 24 * 60 * 60 * 1000;
export const LIFETIME = 30 * DAY;

export function shorten(body, now = Date.now()) {
  if (!isUrl(body?.url)) return { status: 400, json: { error: "not a url" } };
  const code = makeCode();
  store.save(code, body.url, now);
  return { status: 201, json: { code, short: `/${code}` } };
}

export function follow(code, now = Date.now()) {
  const link = store.find(code);
  if (!link) return { status: 404, json: { error: "unknown code" } };
  if (now - link.made > LIFETIME) return { status: 410, json: { error: "this link expired" } };
  store.countVisit(code);
  return { status: 302, location: link.url };
}

export function stats(code) {
  const link = store.find(code);
  if (!link) return { status: 404, json: { error: "unknown code" } };
  return { status: 200, json: { url: link.url, visits: link.visits } };
}
