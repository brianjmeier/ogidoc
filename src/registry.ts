// The sessions running on this machine, one file each, so a chat agent can find a session
// by its name. A name runs once per machine. An entry whose server is gone is dropped
// the next time anyone looks.

import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { sessionName } from "./sessions.ts";

export interface Running {
  name: string;
  // The directory the session was started in.
  cwd: string;
  url: string;
  pid: number;
  agent: string;
  // Where a detached server writes its output.
  log: string;
}

export type Registry = ReturnType<typeof registry>;

// `dir` holds the entries; `alive` says whether a process still runs.
export function registry({ dir, alive }: { dir: string; alive: (pid: number) => boolean }) {
  const file = (name: string) => join(dir, `${name}.json`);
  const read = (f: string): Running | null => {
    try {
      return JSON.parse(readFileSync(f, "utf8"));
    } catch {
      return null;
    }
  };

  function list(): Running[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .flatMap((f) => {
        const e = read(join(dir, f));
        if (e && alive(e.pid)) return [e];
        rmSync(join(dir, f), { force: true });
        return [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // Refuse a name that already runs, here or anywhere else on the machine.
  function check(name: string, cwd: string) {
    const other = list().find((e) => e.name === name);
    if (!other) return;
    if (other.cwd === cwd) throw new Error(`The session ${name} is already open at ${other.url}.`);
    throw new Error(`A session named ${name} already runs in ${other.cwd}. Give this one another name: ogidoc <name>.`);
  }

  return {
    list,
    check,
    // Claim the name. Two servers starting the same name at once can't both win: the
    // entry is written whole beside it and linked into place, which fails if it exists.
    register(e: Running) {
      check(e.name, e.cwd);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${e.name}.${e.pid}.tmp`);
      writeFileSync(tmp, JSON.stringify(e, null, 2) + "\n");
      try {
        try {
          linkSync(tmp, file(e.name));
        } catch (err) {
          // A disk without hard links: create the entry only if it doesn't exist.
          if (!["EPERM", "ENOTSUP", "EXDEV"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
          writeFileSync(file(e.name), readFileSync(tmp), { flag: "wx" });
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        check(e.name, e.cwd);
        throw new Error(`The session ${e.name} was just started by someone else.`);
      } finally {
        rmSync(tmp, { force: true });
      }
    },
    // Only the server that registered a name can let it go.
    release(name: string, pid: number) {
      if (read(file(name))?.pid === pid) rmSync(file(name), { force: true });
    },
    // The running session a command means: the one named, the one started in `cwd`, or
    // the only one running.
    pick({ given, cwd }: { given?: string; cwd: string }): Running {
      const all = list();
      const names = all.map((e) => e.name).join(", ");
      if (given) {
        const name = sessionName(given, all.map((e) => e.name));
        const e = all.find((x) => x.name === name);
        if (e) return e;
        throw new Error(all.length ? `No session named ${name} is running. Running: ${names}.` : `No session named ${name} is running.`);
      }
      // The session started here, or in the nearest folder above.
      const inside = (e: Running) => cwd === e.cwd || cwd.startsWith(e.cwd.endsWith(sep) ? e.cwd : e.cwd + sep);
      const here = all.filter(inside);
      const depth = Math.max(...here.map((e) => e.cwd.length));
      const nearest = here.filter((e) => e.cwd.length === depth);
      if (nearest.length === 1) return nearest[0];
      if (nearest.length > 1) throw new Error(`Several sessions run here: ${nearest.map((e) => e.name).join(", ")}. Name one.`);
      if (all.length === 1) return all[0];
      if (!all.length) throw new Error("No Ogidoc session is running. Start one with: ogidoc --detach");
      throw new Error(`Several sessions are running: ${names}. Name one.`);
    },
  };
}
