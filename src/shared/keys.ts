// The editor's keys on one platform: whether an event is the key, and what to print on
// the control it triggers. macOS uses ⌘ and ⌥; Windows and Linux use Ctrl and Alt.

export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  getModifierState?(key: string): boolean;
}

export function keymap(mac: boolean) {
  const mod = (e: KeyLike) => (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
  // AltGr on Windows and Linux reports Ctrl and Alt and types a character, as on a German [ or µ.
  const altGr = (e: KeyLike) => !!e.getModifierState?.("AltGraph");
  const altOnly = (e: KeyLike) => e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && !altGr(e);
  const alt = mac ? "⌥" : "Alt+";
  return {
    alt,
    // Comment on the caret's line, as Google Docs does. Matched by position: ⌥ changes the letter on macOS.
    comment: { label: mac ? "⌘⌥M" : "Ctrl+Alt+M", is: (e: KeyLike) => mod(e) && e.altKey && !e.shiftKey && !altGr(e) && e.code === "KeyM" },
    // Keep what the caret is in: the shown way of a choice, or a proposal.
    keep: { label: `${alt}↵`, is: (e: KeyLike) => altOnly(e) && e.key === "Enter" },
    reject: { label: `${alt}⌫`, is: (e: KeyLike) => altOnly(e) && e.key === "Backspace" },
    // The other ways of a choice, matched by position so the key sits where [ and ] do on US keyboards.
    prev: { is: (e: KeyLike) => altOnly(e) && e.code === "BracketLeft" },
    next: { is: (e: KeyLike) => altOnly(e) && e.code === "BracketRight" },
    // To the next or previous line that waits on the person. Plain ⌥↓ is taken on macOS
    // (end of paragraph), and Ctrl+Alt+↓ by GNOME (switch workspace).
    jump: {
      label: mac ? "⌥⌘↓" : "Alt+↓",
      by: (e: KeyLike): 1 | -1 | 0 => {
        const held = mac ? e.altKey && e.metaKey && !e.ctrlKey && !e.shiftKey : altOnly(e);
        return !held ? 0 : e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
      },
    },
    // ⌘Z / Ctrl+Z before the person has typed anything since the agent's turn.
    undo: { label: mac ? "⌘Z" : "Ctrl+Z", is: (e: KeyLike) => mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z" },
  };
}

// What to print for the choice keys, from the person's own layout when the browser can
// tell: the keys where [ and ] sit on a US keyboard are Ü and + on a German one.
export function bracketLabels(layout?: { get(code: string): string | undefined }) {
  const at = (code: string, us: string) => (layout?.get(code) || us).toUpperCase();
  return { prev: at("BracketLeft", "["), next: at("BracketRight", "]") };
}
