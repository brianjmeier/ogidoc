import type { Box, MapView, Smell } from "./types.ts";
import { GHOST, ancestorAt, isGhost, trail, visible } from "./shared/level.ts";
import { smellIds, tangleWords } from "./shared/smells.ts";
import { OUTSIDE } from "./scan.ts";

// One level of the map as text, for an agent reading it at a terminal: the boxes on the
// level with what the scan read and what was said about each, the arrows between them,
// and the tangles inside. The same level the editor shows, so both read alike.

const SEAM_SHOWN = 8;

/** The level inside `level` (null: the top of the map). `drifted` are boxes whose code
 *  changed since they were described. */
export function levelText(view: MapView, level: string | null, drifted: string[] = []): string {
  if (level && !view.boxes.some((b) => b.id === level)) throw new Error(`The map has no box "${level}". Run \`ogidoc map\` to see the top of the map.`);
  const { byId, shown, wires } = visible(view.boxes, view.edges, level);
  const nameOf = (id: string) => byId.get(id)?.name ?? id;
  // An arrow names a box by its id, read from this level: `compose.ts`, `kit/timers.ts`,
  // `react (package)`. A box outside the level keeps its whole id.
  const end = (key: string) => {
    const id = isGhost(key) ? key.slice(GHOST.length) : key;
    if (id === OUTSIDE) return "outside";
    if (id.startsWith(`${OUTSIDE}/`)) return `${id.slice(OUTSIDE.length + 1)} (package)`;
    return level && id.startsWith(`${level}/`) ? id.slice(level.length + 1) : id;
  };
  // A tangle shows on the level where its ends sit in different boxes, or on the box it
  // names; deeper ones count on the box that holds them, to be read by opening it.
  const smells: Smell[] = [];
  const deeper = new Map<string, number>();
  for (const s of view.smells) {
    const ids = smellIds(s);
    const at = new Set(ids.map((id) => ancestorAt(id, level, byId)));
    if (at.has(null)) continue;
    const [only] = at;
    if (at.size > 1 || ids.includes(only!)) smells.push(s);
    else deeper.set(only!, (deeper.get(only!) ?? 0) + 1);
  }
  const changed = new Set(drifted);
  const here = level ? view.boxes.find((b) => b.id === level) : undefined;
  const kids = new Map<string, number>();
  for (const b of view.boxes) if (b.parent) kids.set(b.parent, (kids.get(b.parent) ?? 0) + 1);

  const out = [
    [view.title, ...trail(level, byId).map(nameOf)].join(" › "),
    ...(here?.lines.length ? here.lines.map((l) => `| ${l.text}`) : []),
    `${count(shown.length, "box", "boxes")} · ${count(wires.length, "arrow")} · ${count(smells.length, "tangle")}`,
    "",
  ];
  if (!shown.length) out.push("Nothing inside.", "");
  for (const b of shown) out.push(...boxText(b, kids.get(b.id) ?? 0, deeper.get(b.id) ?? 0, changed.has(b.id)), "");
  if (wires.length) {
    out.push("Arrows (uses):");
    for (const w of wires) {
      const types = w.imports && w.members.every((m) => m.typeOnly) ? " (types only)" : "";
      out.push(`  ${end(w.from)} → ${end(w.to)}${types}${w.symbols.length ? `: ${clip(w.symbols, SEAM_SHOWN)}` : w.labels.length ? `: ${w.labels.join(", ")}` : ""}`);
    }
    out.push("");
  }
  if (smells.length) {
    out.push("Tangles:");
    for (const s of smells) {
      const [what, why] = tangleWords(s, nameOf);
      out.push(`  ${s.kind}: ${what}, ${why}`);
    }
    out.push("");
  }
  out.push(...unreadText(view, level));
  const next = shown.find((b) => kids.has(b.id) && b.scan?.kind !== "external");
  out.push(`Open a box: ogidoc map <id>${next ? `, e.g. ogidoc map ${next.id}` : ""}. Say what one does: ogidoc map describe <id>.`);
  return out.join("\n");
}

// What the scan left out under this level: imports of files that aren't there, and (at
// the top) the files in languages it doesn't read. Without it the map looks complete.
function unreadText(view: MapView, level: string | null): string[] {
  const dead = (view.unread?.imports ?? []).filter((u) => !level || u.from.startsWith(`${level}/`));
  const langs = level ? [] : Object.entries(view.unread?.files ?? {}).sort((a, b) => b[1] - a[1]);
  if (!dead.length && !langs.length) return [];
  const out = ["Not read:"];
  if (dead.length) out.push(`  ${count(dead.length, "import")} of code that isn't there, e.g. ${dead.slice(0, 3).map((u) => `${u.from} imports ${u.spec}`).join("; ")}`);
  if (langs.length) out.push(`  files in languages the scan doesn't read: ${langs.map(([ext, n]) => `${n} ${ext}`).join(", ")}`);
  return [...out, ""];
}

function boxText(b: Box, inside: number, tangles: number, changed: boolean): string[] {
  const s = b.scan;
  const facts = s
    ? s.kind === "external"
      ? [b.id === OUTSIDE ? "packages from outside the repo" : "a package from outside the repo"]
      : [
          s.kind === "module" ? count(s.files, "file") : "file",
          count(s.size, "line of code", "lines of code"),
          ...(s.tests ? [count(s.tests, "test file")] : []),
          `used by ${count(s.usedBy, "file")} outside it`,
          `uses ${count(s.uses, "file")} outside it`,
        ]
    : b.code?.length
      ? [`in ${[...new Set(b.code.map((c) => c.file))].join(", ")}`]
      : ["drawn on the map, with no code yet"];
  if (inside) facts.push(`${inside} inside`);
  if (tangles) facts.push(`${count(tangles, "tangle")} inside`);
  const out = [`${b.name === b.id || s?.kind === "external" ? b.name : `${b.name}  ${b.id}`}  ·  ${facts.join(" · ")}`];
  // The same name offered by two files reads once; `*` (a whole-module import) names nothing.
  const names = [...new Set((s?.seam ?? []).map((x) => x.name))].filter((n) => n !== "*");
  if (names.length) out.push(`  exports: ${clip(names, SEAM_SHOWN, names.length + (s!.seamSize - s!.seam.length))}`);
  if (b.lines.length) out.push(...b.lines.map((l) => `  | ${l.text}`));
  else if (s?.kind !== "external") out.push("  not described yet");
  for (const p of b.pins ?? []) out.push(`  ! ${p.kind}: ${p.text}${p.file ? ` (${p.file}${p.line ? `:${p.line}` : ""})` : ""}`);
  if (changed) out.push("  its code changed since it was described");
  return out;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (names: string[], max: number, total = names.length) => names.slice(0, max).join(", ") + (total > max ? `, and ${total - max} more` : "");
