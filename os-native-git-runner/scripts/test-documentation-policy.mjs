import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

assert.match(source, /function safeDocumentationPatch/);
assert.match(source, /const read = new Set<string>\(\)/);
assert.match(source, /let inspectedAfterWrite = false/);
assert.match(source, /let checkedAfterWrite = false/);
assert.match(source, /Read every edited path before writing/);
assert.match(source, /for \(let round = 0; round < 8; round \+= 1\)/);
assert.match(source, /Patch did not apply; inspect the diff\/files and retry/);
assert.match(source, /input = \[\.\.\.input, \.\.\.responseOutput, \.\.\.outputs\]/);
assert.match(source, /strict: true/);
assert.match(source, /pattern: "\^\(README/);
assert.match(source, /check\.success && inspectedAfterWrite && checkedAfterWrite/);
assert.match(source, /path === "README\.md" \|\| \(path\.startsWith\("docs\/"\)/);
assert.match(source, /apply --whitespace=error-all candidate\.patch/);
assert.match(source, /diff --check/);
assert.match(source, /git -C \$\{checkoutDirectory\} add -- README\.md docs/);
assert.match(source, /if \(!agent\.ok\) return Response\.json/);
assert.match(source, /tools: DOC_AGENT_TOOLS/);
assert.doesNotMatch(source, /public\/index\.html/);

console.log("Documentation candidate policy wiring passed");
