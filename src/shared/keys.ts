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
  return {
    // ⌘Z / Ctrl+Z before the person has typed anything since the agent's turn.
    undo: { label: mac ? "⌘Z" : "Ctrl+Z", is: (e: KeyLike) => mod(e) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "z" },
  };
}
