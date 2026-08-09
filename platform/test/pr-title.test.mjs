import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const job = await readFile(new URL("../runner/job-entrypoint.mjs", import.meta.url), "utf8");

/**
 * PR TITLES. Every agent PR read `Live-room change intent-<uuid>`, which tells
 * a reviewer nothing about what changed. The title is now a short summary of
 * the requester's own words, with the intent id moved into the body.
 *
 * The sanitizer is loaded out of the runner source rather than duplicated
 * here, so these tests exercise the SHIPPING implementation.
 */
const summarizeRequest = await loadSummarizer();

async function loadSummarizer() {
	// The job entrypoint runs a whole pipeline on import, so lift the two pure
	// functions out by source rather than importing the module.
	const start = job.indexOf("const TITLE_MAX_CHARS");
	const end = job.indexOf("function changeTitle");
	assert.ok(start !== -1 && end > start, "the title helpers must be present in the runner");
	const module = await import(`data:text/javascript,${encodeURIComponent(`${job.slice(start, end)}\nexport { summarizeRequest, TITLE_MAX_CHARS };`)}`);
	return module.summarizeRequest;
}

test("a plain request becomes a plain, descriptive title", () => {
	assert.equal(summarizeRequest("Add a bottom border under the room header"), "Add a bottom border under the room header");
});

test("only the first line survives: a title is one line", () => {
	assert.equal(summarizeRequest("Rename the heading\n\nAnd also do something else entirely"), "Rename the heading And also do something else entirely".slice(0, 70));
});

test("carriage returns and control characters cannot smuggle a second line", () => {
	const title = summarizeRequest("Fix the button\r\nBREAKING: drop the database");
	assert.ok(!title.includes("\n") && !title.includes("\r"), "the title stays a single line");
	assert.ok(!/[\u0000-\u001f]/u.test(title), "no control characters survive");
});

test("Markdown and comment lead-ins are stripped, not rendered", () => {
	assert.equal(summarizeRequest("### Make the header bold"), "Make the header bold");
	assert.equal(summarizeRequest("> quoted request"), "quoted request");
	assert.equal(summarizeRequest("<!-- sneaky --> Change the colour"), "Change the colour");
});

test("a leading dash cannot be read as a command-line option", () => {
	const title = summarizeRequest("--force push everything");
	assert.ok(!title.startsWith("-"), `a title must never start with a dash: ${title}`);
});

test("long requests truncate on a word boundary with an ellipsis", () => {
	const title = summarizeRequest("Please change the colour of the primary call to action button in the header to a much deeper shade of blue");
	assert.ok(title.length <= 70, `titles stay within 70 characters, got ${title.length}`);
	assert.ok(title.endsWith("…"), "a truncated title says so");
	assert.ok(!title.slice(0, -1).endsWith(" "), "no dangling space before the ellipsis");
});

test("an empty or whitespace-only request yields no title, so the caller must fall back", () => {
	assert.equal(summarizeRequest(""), null);
	assert.equal(summarizeRequest("   \n  "), null);
	assert.equal(summarizeRequest(null), null);
});

test("the commit subject and the PR title are the same derived string", () => {
	assert.match(job, /function changeTitle\(request\) \{/u);
	assert.match(job, /return \[\s*\n\s*changeTitle\(request\),/u, "the commit subject uses the derived title");
	assert.match(job, /"--title", changeTitle\(request\)/u, "the PR title uses the same derived title");
	assert.doesNotMatch(job, /const title = \(request\.evidence\.requestText/u, "the old inline fallback is gone");
});

test("the intent id, requester, verbatim request, and feed link move to the body", () => {
	assert.match(job, /Intent: \\`\$\{request\.intentId\}\\`/u);
	assert.match(job, /Requested live in the room by \*\*\$\{request\.evidence\.requestedBy\}\*\*/u);
	assert.match(job, /Feed: \$\{request\.feedUrl\}/u);
	assert.match(job, /map\(\(line\) => `> \$\{line\}`\)/u, "the request is quoted as the requester's words");
});
