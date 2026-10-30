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
