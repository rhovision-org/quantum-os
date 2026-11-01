// render-expr.test.mjs — what a person reads back from a node.
//
// rnode answers in its own wire shape (`{"ExprPar":[{"ExprInt":12}, …]}`), and
// an unhandled one used to be printed as raw JSON at whoever ran the program.
// The payloads here are real: taken from a live node answering
// `return!(6+6|7+7|8+8) | return!("hi") | return!([1,2]) | return!({"a":1}) | return!(true)`.
//
//   node packages/browser/test/render-expr.test.mjs

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  absWorkingDir: here,
  entryPoints: [join(here, "..", "src", "rholang.ts")],
  bundle: true, format: "esm", platform: "node", write: false,
});
const { renderExpr } = await import(
  "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64"));

let failed = 0;
const check = (label, got, want) => {
  if (got === want) console.log(`  ok   ${label}`);
  else { failed++; console.log(`  FAIL ${label}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
};

// The one that was showing as raw JSON.
check("a par reads as rholang's own |",
  renderExpr({ ExprPar: [{ ExprInt: 12 }, { ExprInt: 14 }, { ExprInt: 16 }] }), "12 | 14 | 16");
check("an empty par is Nil", renderExpr({ ExprPar: [] }), "Nil");

check("an int", renderExpr({ ExprInt: 42 }), "42");
// deploy-status wraps each payload in {data: …} (rholo bc80abb), and a map is
// an object there rather than pairs. Real shape, from a Channel install.
check("deploy-status: a wrapped list",
  renderExpr({ ExprList: { data: [{ ExprString: { data: "installed" } }, { ExprUri: { data: "rho:id:abc" } }] } }),
  '["installed", rho:id:abc]');
check("deploy-status: a wrapped map is an object",
  renderExpr({ ExprMap: { data: { seq: { ExprInt: { data: 2 } }, text: { ExprString: { data: "hi" } } } } }),
  '{"seq": 2, "text": "hi"}');
check("deploy-status: a wrapped tuple with Nil",
  renderExpr({ ExprTuple: { data: [{ ExprString: { data: "posts" } }, { ExprPar: { data: [] } }] } }), '("posts", Nil)');
check("a string keeps its quotes", renderExpr({ ExprString: "hi" }), '"hi"');
check("a bool", renderExpr({ ExprBool: true }), "true");
check("a list", renderExpr({ ExprList: [{ ExprInt: 1 }, { ExprInt: 2 }] }), "[1, 2]");
check("a map, which arrives as pairs", renderExpr({ ExprMap: [["a", { ExprInt: 1 }]] }), '{"a": 1}');
check("a tuple", renderExpr({ ExprTuple: [{ ExprInt: 1 }, { ExprString: "x" }] }), '(1, "x")');
check("nested: a par of lists",
  renderExpr({ ExprPar: [{ ExprList: [{ ExprInt: 1 }] }, { ExprString: "x" }] }), '[1] | "x"');
check("nothing", renderExpr(null), "Nil");

// An expression a future build names differently should not become JSON.
check("an unknown Expr renders its contents, not rnode's wire shape",
  renderExpr({ ExprSomethingNew: { ExprInt: 7 } }), "7");

console.log(failed === 0 ? "\nrender-expr: all passed" : `\nrender-expr: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
