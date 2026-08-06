import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

assert.match(source, /function safeDocumentationPatch/);
assert.match(source, /path === "README\.md" \|\| \(path\.startsWith\("docs\/"\)/);
assert.match(source, /apply --whitespace=error-all candidate\.patch/);
assert.match(source, /diff --check/);
assert.match(source, /git -C \$\{checkoutDirectory\} add -- README\.md docs/);
assert.doesNotMatch(source, /public\/index\.html/);

console.log("Documentation candidate policy wiring passed");
