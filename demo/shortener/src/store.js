// Links live in memory: code → { url, visits }.
const links = new Map();

export const store = {
  save: (code, url) => links.set(code, { url, visits: 0 }),
  find: (code) => links.get(code),
  countVisit: (code) => { links.get(code).visits++; },
};
