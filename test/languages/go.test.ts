import { test } from "node:test";
import assert from "node:assert/strict";
import { go, importsOf, outsideOf } from "../../src/languages/go.ts";
import { arrows, scanOf } from "./scan-of.ts";

test("go: single, aliased, dot, blank and grouped imports; comments and strings don't count", () => {
  const got = importsOf(`package main

// import "example.com/commented"
/* import "example.com/blocked" */
import "fmt"
import st "example.com/shop/internal/store"
import (
	// "example.com/also/commented"
	"net/http"
	. "example.com/dot"
	_ "example.com/driver"
	y "gopkg.in/yaml.v3"
	"github.com/a/b/v2"
)

var fixture = \`import "example.com/raw"\`
var s = "import \\"example.com/quoted\\""

func main() { fmt.Println(st.Open(), http.Get, y.Marshal, b.New(), fmt.Sprintf) }
`);
  assert.deepEqual(got, [
    { spec: "fmt", symbols: ["Println", "Sprintf"] },
    { spec: "example.com/shop/internal/store", symbols: ["Open"] },
    { spec: "net/http", symbols: ["Get"] },
    { spec: "example.com/dot", symbols: ["*"] },
    { spec: "example.com/driver", symbols: ["*"] },
    { spec: "gopkg.in/yaml.v3", symbols: ["Marshal"] },
    { spec: "github.com/a/b/v2", symbols: ["New"] },
  ]);
});

test("go: outside packages are named by module, the standard library as one", () => {
  assert.deepEqual(
    ["fmt", "net/http", "github.com/a/b/c/d", "golang.org/x/net/html", "gopkg.in/yaml.v3", "example.com/lib/v3", "gitlab.com/g/p/sub"].map(outsideOf),
    ["std", "std", "github.com/a/b", "golang.org/x/net", "gopkg.in/yaml.v3", "example.com/lib", "gitlab.com/g/p"],
  );
});

const shop = {
  "cmd/shop/main.go": `package main

import (
	"fmt"
	"example.com/shop/internal/store"
	"example.com/shop/internal/gone"
)

func main() { fmt.Println(store.Open(), gone.X) }
`,
  "internal/store/store.go": `package store

func Open() int { return 1 }
`,
  "internal/store/store_test.go": `package store

import "example.com/shop/internal/pricing"

func TestOpen() { _ = pricing.Total }
`,
  "internal/pricing/pricing.go": `package pricing

var (
	unexported = f()
	Total = 2
)
`,
  "internal/unused/unused.go": `package unused

type Thing struct{}
`,
  "internal/quiet/quiet.go": `package quiet

func helper() {}
`,
};

test("go: in-repo imports land on the package folder, outside ones on their module", () => {
  const sk = scanOf(shop, { "go.mod": "module example.com/shop\n\ngo 1.22\n" });
  assert.deepEqual(arrows(sk), [
    "cmd/shop/main.go → (outside)/std: Println",
    "cmd/shop/main.go → internal/store: Open",
  ]);
  assert.deepEqual(sk.unread.imports, [{ from: "cmd/shop/main.go", spec: "example.com/shop/internal/gone" }]);
});

test("go: a test is an importer, and an exported package nobody imports is unused", () => {
  const sk = scanOf(shop, { "go.mod": "module example.com/shop\n" });
  assert.ok(!sk.edges.some((e) => e.from.endsWith("_test.go")), "tests draw no arrows");
  assert.deepEqual(sk.smells.filter((s) => s.kind === "unused"), [{ kind: "unused", a: "internal/unused/unused.go" }]);
});

test("go: the longest module path wins across nested go.mod files", () => {
  const sk = scanOf({
    "app/main.go": `package main\n\nimport "example.com/shop/tools/rules"\n\nfunc main() { rules.All() }\n`,
    "devtools/rules/rules.go": `package rules\n\nfunc All() {}\n`,
  }, { "go.mod": "module example.com/shop\n", "devtools/go.mod": "module example.com/shop/tools // nested\n" });
  assert.deepEqual(arrows(sk), ["app/main.go → devtools/rules: All"]);
});
