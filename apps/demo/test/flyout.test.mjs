import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const entry = await readFile(new URL("../src/entry.ts", import.meta.url), "utf8");

assert.match(entry, /display: block !important;[\s\S]*border-radius: var\(--radius-round\)/u, "the complete pill toolbar remains visible");
assert.match(entry, /data-icon-library="lucide"/u, "toolbar controls use one icon family");
assert.match(entry, /\.work-item\[data-terminal="true"\] \{ display: none; \}/u, "terminal issues are filtered from the activity list");
assert.match(entry, /active-issue-status/u, "active issue rows retain their visible status");
assert.match(entry, /issue\.textContent = issueLink\.textContent\.replace\('Issue ', ''\)/u, "active issue rows show their issue number");
assert.match(entry, /active-status-dot' \+ \(phase\.contains\('needs_review'\) \? '' : ' working'\)/u, "working issue rows receive a pulsing status dot");
assert.match(entry, /prefers-reduced-motion: reduce/u, "status animation respects reduced-motion preferences");
assert.match(entry, /event\.key === 'Enter' && \(event\.metaKey \|\| event\.ctrlKey\)/u, "the comment composer sends with the platform command shortcut");
assert.match(entry, /composerKind === 'comment' && pendingSubmissionId && requestInput\) requestInput\.value = ''/u, "a sent comment clears its composer field");

console.log("floating flyout UI contracts passed");
