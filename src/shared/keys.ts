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
    // ⌘Z / Ctrl+Z before the person has typed anything since the agent's turn.
    undo: { label: mac ? "⌘Z" : "Ctrl+Z", is: (e: KeyLike) => mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z" },
  };
}
