// Links live in memory: code → { url, visits, createdAt }.
const links = new Map();

export const store = {
  save: (code, url) => links.set(code, { url, visits: 0, createdAt: Date.now() }),
  find: (code) => links.get(code),
  countVisit: (code) => { links.get(code).visits++; },
};
