import { test } from "node:test";
import assert from "node:assert/strict";
import { importsOf, rust } from "../../src/languages/rust.ts";
import { arrows, scanOf } from "./scan-of.ts";

test("rust: every leaf of a use tree is a path, with renames, pub use and extern crate", () => {
  const got = importsOf(`
extern crate serde;
pub use crate::a::{B, c::{self, D as E}, *};
use ::log :: info;
pub(crate) use self::x::Y;
`);
  assert.deepEqual(got, [
    { spec: "serde", symbols: ["*"] },
    { spec: "crate::a::B", symbols: ["B"] },
    { spec: "crate::a::c::self", symbols: ["*"] },
    { spec: "crate::a::c::D", symbols: ["D"] },
    { spec: "crate::a::*", symbols: ["*"] },
    { spec: "::log::info", symbols: ["info"] },
    { spec: "self::x::Y", symbols: ["Y"] },
  ]);
});

test("rust: comments, strings, raw strings and char literals hide nothing and invent nothing", () => {
  const got = importsOf(`
/* outer /* nested */ use crate::still_comment; */
// use crate::commented;
const S: &str = "use crate::in_string;";
const R: &str = r#"use crate::"raw";"#;
fn f<'a>(x: &'a str) -> char { let q = '"'; let t = '\\''; 'x' }
use crate::real;
`);
  assert.deepEqual(got.map((i) => i.spec), ["crate::real"]);
});

test("rust: super inside an inline test module is the file itself", () => {
  assert.deepEqual(importsOf(`#[cfg(test)]\nmod tests {\n  use super::*;\n  use super::super::Up;\n}`).map((i) => i.spec), ["self::*", "super::Up"]);
});

test("rust: tests are tests/, benches/ and *_test.rs", () => {
  assert.deepEqual(["benches/speed.rs", "src/store_test.rs", "src/store.rs"].map(rust.isTest), [true, true, false]);
});

const shop = {
  "crates/core/src/lib.rs": `pub mod store;\npub mod extra;\nmod report;\nmod broken;\n`,
  "crates/core/src/store.rs": `pub mod disk;\nuse crate::store::disk::save;\n// use crate::extra::Nope;\nconst S: &str = "use crate::extra::Fake;";\npub struct Store;\n`,
  "crates/core/src/store/disk.rs": `use super::Store;\npub fn save(_: &Store) {}\n#[cfg(test)]\nmod tests {\n    use super::*;\n}\n`,
  "crates/core/src/extra.rs": `pub fn helper() {}\n`,
  "crates/core/src/report.rs": `pub fn report() {}\n`,
  "crates/core/src/broken.rs": `use crate::gone::X;\nfn f() {}\n`,
  "crates/cli/src/main.rs": `use shop_core::store::Store;\nuse std::fs;\nuse serde::Deserialize;\nfn main() { let c = '"'; }\n`,
  "crates/cli/tests/smoke.rs": `use shop_core::report::report;\n`,
};
const cargo = {
  "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n`,
  "crates/core/Cargo.toml": `[package]\nname = "shop-core"\nversion = "0.1.0"\n\n[dependencies]\nname = "not-this"\n`,
  "crates/cli/Cargo.toml": `[package]\nname = "shop-cli"\n`,
};

test("rust: a workspace's arrows land on module files, other crates by name, std as one", () => {
  const sk = scanOf(shop, cargo);
  assert.deepEqual(arrows(sk), [
    "crates/cli/src/main.rs → (outside)/serde: Deserialize",
    "crates/cli/src/main.rs → (outside)/std: fs",
    "crates/cli/src/main.rs → crates/core/src/store.rs: Store",
    "crates/core/src/store.rs → crates/core/src/store/disk.rs: save",
    "crates/core/src/store/disk.rs → crates/core/src/store.rs: Store",
  ]);
});

test("rust: an unused pub module, a dead crate:: path, and what a test imports", () => {
  const sk = scanOf(shop, cargo);
  assert.deepEqual(sk.smells.filter((s) => s.kind === "unused"), [{ kind: "unused", a: "crates/core/src/extra.rs" }]);
  assert.deepEqual(sk.unread.imports, [{ from: "crates/core/src/broken.rs", spec: "crate::gone::X" }]);
  assert.deepEqual(sk.smells.filter((s) => s.kind === "pass-through"), [], "a crate root of `mod` lines lays out its modules");
});

test("rust: mod.rs is its folder's module, a bin is its own root, an inline mod is not dead", () => {
  const sk = scanOf({
    "src/lib.rs": `pub mod net;\npub mod util { pub mod inner { pub fn go() {} } }\n`,
    "src/net/mod.rs": `pub mod tcp;\nuse crate::util::inner::go;\nuse crate::Thing;\npub struct Net;\n`,
    "src/net/tcp.rs": `use super::Net;\nuse self::super::super::net::{self};\npub fn tcp() {}\n`,
    "src/bin/tool.rs": `mod args;\nuse crate::args::parse;\nuse demo::net::tcp::tcp;\nfn main() {}\n`,
    "src/bin/args.rs": `pub fn parse() {}\n`,
  }, { "Cargo.toml": `[package]\nname = "demo"\n` });
  assert.deepEqual(arrows(sk), [
    "src/bin/tool.rs → src/bin/args.rs: parse",
    "src/bin/tool.rs → src/net/tcp.rs: tcp",
    "src/net/mod.rs → src/lib.rs: go, Thing",
    "src/net/tcp.rs → src/net/mod.rs: Net, *",
  ]);
  assert.deepEqual(sk.unread.imports, []);
});
