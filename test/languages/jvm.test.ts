import { test } from "node:test";
import assert from "node:assert/strict";
import { importsOf, jvm } from "../../src/languages/jvm.ts";
import { isTest } from "../../src/languages/index.ts";
import { arrows, scanOf } from "./scan-of.ts";

const SHOP = {
  "src/main/java/com/shop/store/Store.java": `package com.shop.store;\n\npublic class Store {\n  public static Store open() { return new Store(); }\n}\n`,
  "src/main/java/com/shop/store/Checkout.java": `package com.shop.store;\n\npublic final class Checkout {}\n`,
  "src/main/java/com/shop/store/Unused.java": `package com.shop.store;\n\n@Deprecated\npublic class Unused {}\n`,
  "src/main/java/com/shop/App.java": [
    "package com.shop;",
    "",
    "import com.shop.store.Store;",
    "import static com.shop.store.Store.open;",
    "import com.shop.store.Gone;",
    "import com.shop.util.format;",
    "import org.slf4j.Logger;",
    "import java.util.List;",
    "// import com.shop.store.Unused;",
    "/* import com.shop.store.Unused; */",
    "",
    "public class App {",
    '  String s = "import com.shop.store.Unused;";',
    '  String t = """',
    "import com.shop.store.Unused;",
    '""";',
    "}",
  ].join("\n"),
  "src/main/kotlin/com/shop/util/Money.kt": `package com.shop.util\n\nimport com.shop.store.Store as Shop\nimport kotlin.math.round\n\nfun format(cents: Long): String = "$cents"\n`,
  "src/test/java/com/shop/store/StoreTest.java": `package com.shop.store;\n\nimport com.shop.store.Checkout;\nimport org.junit.jupiter.api.Test;\n\nclass StoreTest {}\n`,
};

test("jvm: imports are read, but not in comments, strings or text blocks", () => {
  const got = importsOf(SHOP["src/main/java/com/shop/App.java"]);
  assert.deepEqual(got.map((i) => [i.spec, ...i.symbols]), [
    ["com.shop.store.Store", "Store"],
    ["com.shop.store.Store.open", "open"],
    ["com.shop.store.Gone", "Gone"],
    ["com.shop.util.format", "format"],
    ["org.slf4j.Logger", "Logger"],
    ["java.util.List", "List"],
  ]);
  assert.deepEqual(importsOf("import a.b.*\nimport a.b.C as D\nimport static a.b.C.*;").map((i) => [i.spec, ...i.symbols]), [
    ["a.b.*", "*"],
    ["a.b.C", "C"],
    ["a.b.C.*", "*"],
  ]);
});

test("jvm: types land on their file, packages and top-level functions on their folder, the rest outside", () => {
  const sk = scanOf({ ...SHOP, "src/main/java/com/shop/Cli.java": `package com.shop;\nimport com.shop.store.*;\nimport com.shop.store.Store.Inner;\npublic class Cli {}\n` });
  assert.deepEqual(arrows(sk), [
    "src/main/java/com/shop/App.java → (outside)/org.slf4j: Logger",
    "src/main/java/com/shop/App.java → (outside)/std: List",
    "src/main/java/com/shop/App.java → src/main/java/com/shop/store/Store.java: Store, open",
    "src/main/java/com/shop/App.java → src/main/kotlin/com/shop/util: format",
    "src/main/java/com/shop/Cli.java → src/main/java/com/shop/store/Store.java: Inner",
    "src/main/java/com/shop/Cli.java → src/main/java/com/shop/store: *",
    "src/main/kotlin/com/shop/util/Money.kt → (outside)/std: round",
    "src/main/kotlin/com/shop/util/Money.kt → src/main/java/com/shop/store/Store.java: Store",
  ]);
});

test("jvm: a test imports without an arrow, an unimported public class is unused, a missing type is unread", () => {
  assert.ok(isTest("src/test/java/com/shop/store/StoreTest.java"), "src/test/ is a test folder");
  assert.ok(jvm.isTest("app/FooTests.kt") && jvm.isTest("app/StoreIT.java") && !jvm.isTest("app/Testing.java"));
  const sk = scanOf(SHOP);
  assert.ok(!arrows(sk).some((a) => a.startsWith("src/test/")));
  assert.deepEqual(sk.smells.filter((s) => s.kind === "unused"), ["src/main/java/com/shop/store/Unused.java", "src/main/java/com/shop/App.java"].map((a) => ({ kind: "unused", a })), "the test imports Checkout; nothing imports the entry point");
  assert.deepEqual(sk.unread.imports, [{ from: "src/main/java/com/shop/App.java", spec: "com.shop.store.Gone" }]);
});

test("jvm: offersNames is a public Java type, or a Kotlin top-level that isn't private or internal", () => {
  assert.equal(jvm.offersNames!("package a;\nclass Hidden {}\n", "a/Hidden.java"), false);
  assert.equal(jvm.offersNames!("package a;\npublic record Point(int x) {}\n", "a/Point.java"), true);
  assert.equal(jvm.offersNames!("package a\n\nprivate fun x() = 1\ninternal class Y\n", "a/x.kt"), false);
  assert.equal(jvm.offersNames!("package a\n\ndata class Z(val n: Int)\n", "a/Z.kt"), true);
});
