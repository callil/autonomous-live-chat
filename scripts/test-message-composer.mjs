import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

assert.match(html, /id="input"[^>]*aria-describedby="message-count"[^>]*maxlength="500"/);
assert.match(html, /id="message-count"[^>]*aria-live="polite">0 \/ 500<\/output>/);
assert.match(html, /const length = input\.value\.length;/);
assert.match(html, /messageCount\.textContent = `\$\{length\} \/ 500`;/);
assert.match(html, /messageCount\.classList\.toggle\('warning', length >= 450\);/);
assert.match(css, /\.message-count\.warning\s*{[^}]*color: var\(--color-warning\);/s);
assert.match(worker, /const MAX_MESSAGE_LENGTH = 500;/);

// Guard the established keyboard contract while changing composer behavior.
assert.match(html, /event\.key === 'Enter' && !event\.shiftKey/);
assert.match(html, /event\.preventDefault\(\); form\.requestSubmit\(\);/);

console.log("message composer character limit contracts passed");
