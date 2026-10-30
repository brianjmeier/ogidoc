import type { Status, Symbol } from "../src/types.ts";
import { createSignal } from "solid-js";
import { bracketLabels, keymap } from "../src/shared/keys.ts";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const STATUS_LABEL: Record<Status, string> = { built: "built", stale: "needs a build", blocked: "waiting on a comment" };
// Shapes people already read: done, not yet, paused (the pause bars are drawn in CSS).
export const STATUS_MARK: Record<Status, string> = { built: "✓", stale: "◌", blocked: "" };

export const keys = keymap(/Mac|iPhone|iPad/.test(navigator.platform));
// Only Chromium reads the layout; elsewhere the choice keys print as [ and ].
export const [brackets, setBrackets] = createSignal(bracketLabels());
type LayoutMap = { get(code: string): string | undefined };
(navigator as { keyboard?: { getLayoutMap?(): Promise<LayoutMap> } }).keyboard?.getLayoutMap?.().then((m) => setBrackets(bracketLabels(m)), () => {});

// Real names from the codebase, longest first so a longer name wins over its prefix.
export function symbolPattern(symbols: Symbol[]): RegExp | null {
  if (!symbols.length) return null;
  const names = symbols.map((s) => s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\w.])(${names.join("|")})(?!\\w)`, "g");
}

// Escaped HTML for a line, with known names marked.
export function decorate(s: string, re: RegExp | null): string {
  const e = esc(s);
  return re ? e.replace(re, (m) => `<span class="sym">${m}</span>`) : e;
}
