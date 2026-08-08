import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../public/app.css", import.meta.url), "utf8");
const enhancements = await readFile(new URL("../public/avatar-colors.js", import.meta.url), "utf8");

assert.match(css, /\.topbar\s*\{[\s\S]*?position: sticky;[\s\S]*?top: var\(--space-0\);/u, "the room header remains pinned to the top of its scroll container");
assert.match(enhancements, /scrollContainer\.addEventListener\('scroll', updateHeader, \{ passive: true \}\)/u, "header depth responds efficiently to scrolling");
assert.match(enhancements, /header\.classList\.toggle\('has-scrolled', scrollContainer\.scrollTop > 0\)/u, "the shadow is only enabled after the page has scrolled");
assert.match(enhancements, /\.topbar\.has-scrolled \{ box-shadow: 0 0\.25rem 0\.75rem rgba\(0, 0, 0, 0\.06\); \}/u, "the scrolled header uses a subtle shadow");

console.log("fixed header scroll contracts passed");
