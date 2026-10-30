import { test } from "node:test";
import assert from "node:assert/strict";
import { keymap, type KeyLike } from "../src/shared/keys.ts";

const press = (key: string, mods: Partial<KeyLike> = {}, code = ""): KeyLike => ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
const mac = keymap(true);
const pc = keymap(false);

test("undo is ⌘Z on macOS and Ctrl+Z elsewhere, never redo", () => {
  assert.ok(mac.undo.is(press("z", { metaKey: true })));
  assert.ok(!mac.undo.is(press("z", { ctrlKey: true })));
  assert.ok(!mac.undo.is(press("z", { metaKey: true, shiftKey: true })));
  assert.ok(pc.undo.is(press("z", { ctrlKey: true })));
  assert.ok(!pc.undo.is(press("z", { metaKey: true })));
  assert.equal(mac.undo.label, "⌘Z");
  assert.equal(pc.undo.label, "Ctrl+Z");
});

test("the comment key is matched by position, and AltGr typing a character is not it", () => {
  // ⌥ turns m into µ on macOS, so the letter can't be trusted.
  assert.ok(mac.comment.is(press("µ", { metaKey: true, altKey: true }, "KeyM")));
  assert.ok(pc.comment.is(press("m", { ctrlKey: true, altKey: true }, "KeyM")));
  const altGr = { ...press("µ", { ctrlKey: true, altKey: true }, "KeyM"), getModifierState: (k: string) => k === "AltGraph" };
  assert.ok(!pc.comment.is(altGr));
  assert.equal(mac.comment.label, "⌘⌥M");
  assert.equal(pc.comment.label, "Ctrl+Alt+M");
});

test("⌥ alone keeps, rejects and switches ways; other modifiers leave the key to the text", () => {
  assert.ok(mac.keep.is(press("Enter", { altKey: true })));
  assert.ok(!mac.keep.is(press("Enter", { altKey: true, metaKey: true })));
  assert.ok(pc.reject.is(press("Backspace", { altKey: true })));
  assert.ok(!pc.reject.is(press("Backspace", { altKey: true, ctrlKey: true })));
  assert.ok(mac.next.is(press("‘", { altKey: true }, "BracketRight")));
  assert.ok(!pc.prev.is({ ...press("[", { altKey: true, ctrlKey: true }, "Digit8"), getModifierState: () => true }));
  assert.equal(mac.keep.label, "⌥↵");
  assert.equal(pc.reject.label, "Alt+⌫");
});
