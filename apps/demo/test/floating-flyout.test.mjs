import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const entry = await readFile(new URL("../src/entry.ts", import.meta.url), "utf8");

assert.match(entry, /\.harness-launcher \{ display: none !important; \}/u, "the old reveal button is removed from the flyout interaction");
assert.match(entry, /\.authoring-popover \{[\s\S]*border-radius: var\(--radius-round\)/u, "the always-visible flyout is pill-shaped");
assert.match(entry, /\.authoring-tools \{ display: flex; align-items: center;/u, "all flyout controls share one inline row");
assert.match(entry, /if \(launcher\?\.getAttribute\('aria-expanded'\) === 'false'\) launcher\.click\(\);/u, "the existing accessible overlay behavior is initialized without requiring a user click");

assert.match(entry, /data-icon-library="lucide"/u, "flyout controls use the shared Lucide icon set");
assert.match(entry, /\.work-item\[data-terminal="true"\] \{ display: none; \}/u, "terminal issues are filtered from the open-issues list");
assert.match(entry, /issueLabel = issue\?\.textContent\?\.replace\(\/\^Issue \/, ''\)/u, "active rows retain their issue number");
assert.match(entry, /status\.textContent = phase\.textContent \|\| 'Active';/u, "active rows show their current status");
assert.match(entry, /active-status-dot' \+ \(phase\.classList\.contains\('needs_review'\) \? '' : ' working'\)/u, "working rows receive the pulsing status-dot state");
assert.match(entry, /@media \(prefers-reduced-motion: reduce\) \{ \.active-status-dot\.working \{ animation: none; \} \}/u, "status animation respects reduced-motion preferences");

assert.match(entry, /event\.key === 'Enter' && \(event\.metaKey \|\| event\.ctrlKey\)/u, "the change-request composer submits with Cmd+Enter and its cross-platform equivalent");
assert.match(entry, /requestForm\.requestSubmit\(\);/u, "the keyboard shortcut follows native form validation and submission semantics");
assert.match(entry, /requestInput\.value = '';[\s\S]*requestInput\.dispatchEvent\(new Event\('input', \{ bubbles: true \}\)\);/u, "the composer clears both its field and input state after an acknowledged send");

console.log("floating flyout UI contracts passed");
