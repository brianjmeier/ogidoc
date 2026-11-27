import { test } from "node:test";
import assert from "node:assert/strict";
import { importsOf, python } from "../../src/languages/python.ts";
import { arrows, scanOf } from "./scan-of.ts";

test("python: every import form is read, and comments and strings don't count", () => {
  const got = importsOf([
    `"""Docstring.\nimport fake_in_docstring\n"""`,
    `import a.b`,
    `import c.d as e, f`,
    `from g.h import i, j as k`,
    `from l import (\n    m,\n    n,  # why\n)`,
    `from . import o`,
    `from ..p.q import r`,
    `from s import *`,
    `# import commented`,
    `text = "import in_a_string"`,
    `def go():\n    import inside`,
  ].join("\n"));
  assert.deepEqual(got.map((i) => `${i.spec}: ${i.symbols.join(", ")}`), [
    "a.b: *", "c.d: *", "f: *", "g.h: i", "g.h: j", "l: m", "l: n", ".: o", "..p.q: r", "s: *", "inside: *",
  ]);
});

test("python: imports under `if TYPE_CHECKING:` are type-only, and only those", () => {
  const got = importsOf(`from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from a import B\n\n    import c\nimport d`);
  assert.deepEqual(got.map((i) => [i.spec, !!i.typeOnly]), [["typing", false], ["a", true], ["c", true], ["d", false]]);
});

const shop = {
  "src/shop/__init__.py": `"""The shop."""\nfrom .store import save\n\n__all__ = [\n    "save",\n]\n`,
  "src/shop/store.py": `def save(item):\n    return item\n`,
  "src/shop/cli.py": `from .store import save\nimport requests\nfrom shop.util import money\nfrom .gone import x\n\nif __name__ == "__main__":\n    save(money.cents(1))\n`,
  "src/shop/util/__init__.py": ``,
  "src/shop/util/money.py": `def cents(n):\n    return n * 100\n`,
  "src/shop/stale.py": `TAX_RATE = 0.2\n`,
  "src/shop/report.py": `def report():\n    return ""\n`,
  "src/shop/test_report.py": `from shop.report import report\n`,
  "tests/test_store.py": `from shop.store import save\n\ndef test_save():\n    assert save(1) == 1\n`,
};

test("python: imports land on the module file, a package from outside by its name", () => {
  const sk = scanOf(shop, { "pyproject.toml": `[project]\nname = "shop"\n` });
  assert.deepEqual(arrows(sk), [
    "src/shop/__init__.py → src/shop/store.py: save",
    "src/shop/cli.py → (outside)/requests: *",
    "src/shop/cli.py → src/shop/store.py: save",
    "src/shop/cli.py → src/shop/util/money.py: money",
    // a top folder of only tests is code of its own, so it draws arrows
    "tests/test_store.py → src/shop/store.py: save",
  ]);
});

test("python: a test file is an importer, what only a test imports is not unused, a module nobody imports is, a dead import is unread", () => {
  const sk = scanOf(shop, { "pyproject.toml": "" });
  assert.ok(python.isTest("tests/test_store.py") && python.isTest("pkg/store_test.py") && python.isTest("conftest.py"));
  assert.ok(!sk.edges.some((e) => e.from === "src/shop/test_report.py"), "a test beside the code draws no arrow");
  assert.deepEqual(sk.smells.filter((s) => s.kind === "unused"), [{ kind: "unused", a: "src/shop/stale.py" }]);
  assert.deepEqual(sk.smells.filter((s) => s.kind === "pass-through"), [{ kind: "pass-through", a: "src/shop/__init__.py" }]);
  assert.deepEqual(sk.unread.imports, [{ from: "src/shop/cli.py", spec: ".gone" }]);
});

test("python: a name this repo's package lacks is dead, not outside", () => {
  const sk = scanOf({
    "src/shop/__init__.py": ``,
    "src/shop/app.py": `import shop.nothere\nimport os.path\n`,
  });
  assert.deepEqual(sk.unread.imports, [{ from: "src/shop/app.py", spec: "shop.nothere" }]);
  assert.deepEqual(sk.edges.map((e) => e.to.split("/").pop()), ["os"]);
});
