// Links live in memory: code → { url, visits, made }.
const links = new Map();

export const store = {
  save: (code, url, made) => links.set(code, { url, visits: 0, made }),
  find: (code) => links.get(code),
  countVisit: (code) => { links.get(code).visits++; },
};
