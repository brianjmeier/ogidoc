// Per client ip: at most `limit` shortens in any `windowMs` (sliding window).
export function createRateLimit({ limit = 10, windowMs = 60_000, now = Date.now } = {}) {
  const recent = new Map(); // ip → times of its recent shortens

  return {
    allow(ip) {
      const t = now();
      const times = (recent.get(ip) ?? []).filter((at) => t - at < windowMs);
      if (times.length >= limit) {
        recent.set(ip, times);
        return false;
      }
      times.push(t);
      recent.set(ip, times);
      return true;
    },
  };
}

export const shortenLimit = createRateLimit();
