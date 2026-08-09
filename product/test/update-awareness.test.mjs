import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const html = await readFile(new URL("../src/ui/room.html", import.meta.url), "utf8");
const css = await readFile(new URL("../src/ui/room.css", import.meta.url), "utf8");

test("the room detects a newer deployed revision and offers an explicit update", () => {
	assert.match(html, /meta name="ahp-version" content="__DEPLOY_SHA__"/u);
	assert.match(worker, /replace\("__DEPLOY_SHA__", validDeploySha\(env\.DEPLOY_SHA\)/u);
	assert.match(html, /fetch\('\/version', \{ cache: 'no-store' \}\)/u);
	assert.match(html, /current\.sha !== loadedSha\) notice\.hidden = false/u);
	assert.match(html, /id="app-update" role="status" hidden/u);
	assert.match(html, /button\.addEventListener\('click', function \(\) \{ location\.reload\(\); \}\)/u);
	assert.match(html, /visibilitychange/u);
	assert.match(css, /\.app-update \{/u);
});
