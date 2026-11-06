import { isUrl } from "./validate.js";
import { makeCode } from "./codes.js";
import { store } from "./store.js";

// A short link lives for 7 days after it is made.
export const LINK_TTL = 7 * 24 * 60 * 60 * 1000;

export function isExpired(link) {
  return Date.now() - link.createdAt > LINK_TTL;
}

const EXPIRED = { status: 410, json: { error: "link expired" } };

export function shorten(body) {
  if (!isUrl(body?.url)) return { status: 400, json: { error: "not a url" } };
  const code = makeCode();
  store.save(code, body.url);
  return { status: 201, json: { code, short: `/${code}` } };
}

export function follow(code) {
  const link = store.find(code);
  if (!link) return { status: 404, json: { error: "unknown code" } };
  if (isExpired(link)) return EXPIRED;
  store.countVisit(code);
  return { status: 302, location: link.url };
}

export function stats(code) {
  const link = store.find(code);
  if (!link) return { status: 404, json: { error: "unknown code" } };
  if (isExpired(link)) return EXPIRED;
  return { status: 200, json: { url: link.url, visits: link.visits } };
}
