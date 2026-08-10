import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const job = await readFile(new URL("../job-entrypoint.mjs", import.meta.url), "utf8");
const agent = await readFile(new URL("../agent-entrypoint.mjs", import.meta.url), "utf8");
const dockerfile = await readFile(new URL("../Dockerfile", import.meta.url), "utf8");
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");

test("all stack machinery is gone: plain branches and plain PRs only", () => {
	for (const [name, source] of [["worker", worker], ["job", job], ["agent", agent], ["dockerfile", dockerfile]]) {
		assert.doesNotMatch(source, /gh[ -]stack/iu, `${name} must not use gh stack`);
		assert.doesNotMatch(source, /expectedOrder/u, `${name} must not carry stack topology`);
		assert.doesNotMatch(source, /parentBranch|parentBaseSha|stackId/u, `${name} must not carry stack identity`);
		assert.doesNotMatch(source, /app-harness-os\//u, `${name} must not reference the legacy stack branch namespace`);
	}
});

test("the branch contract is plain room/<intentSeq>/<attempt> from latest main", () => {
	const pattern = /room\\\/\\d\{1,12\}\\\/\[a-f0-9\]\{4,32\}/u;
	assert.match(worker, pattern, "the worker validates the room branch shape");
	assert.match(job, pattern, "the job validates the room branch shape");
	assert.match(job, /"clone", .*"--branch", "main"/u, "the job clones latest main");
	assert.match(job, /"--depth", "1", "--single-branch"/u, "latest main only: history is not on the critical path");
	assert.match(job, /"checkout", "-b", request\.branch/u, "the job creates a plain branch");
});

test("the runner reports by push and never merges: the platform owns CI, merge, and deploy", () => {
	assert.match(job, /state: "verifying", branch: request\.branch, prNumber, headSha/u);
	assert.match(job, /timings: \{ \.\.\.timings/u, "per-phase timings ride the terminal report");
	assert.doesNotMatch(job, /auto-?merge|--auto/iu, "no auto-merge arming — the platform merges");
	assert.doesNotMatch(job, /pulls\/\d+\/merge|"pr", "merge"/u, "the runner never merges");
	assert.match(job, /"pr", "create", "--base", "main"/u, "a plain PR against main");
});

test("attribution trailers ride every commit: Co-authored-by, Requested-by, feed link", () => {
	assert.match(job, /Co-authored-by: \$\{request\.evidence\.requestedBy\}/u);
	assert.match(job, /Requested-by: \$\{request\.evidence\.requestedBy\} \(\$\{request\.feedUrl\}\)/u);
});

test("annotation payloads ride to the agent verbatim as CONTEXT, never scope authority", () => {
	assert.match(job, /JSON\.stringify\(evidence\.annotations/u, "annotations are serialized verbatim");
	assert.match(job, /NOT a restriction/u, "the prompt says anchors are context, not scope");
});

test("local tests gate the push, heartbeats flow, and the callback carries runId bearer plus attemptId", () => {
	assert.match(job, /product\/test\/ui-contract\.test\.mjs/u, "the local gate runs the PRODUCT's own dependency-free tests");
	const pushIndex = job.indexOf('"push", "origin"');
	const testsIndex = job.indexOf("product/test/ui-contract.test.mjs");
	assert.ok(testsIndex !== -1 && pushIndex !== -1 && testsIndex < pushIndex, "local tests run BEFORE the push");
	assert.match(job, /progress: true, step/u, "step heartbeats post to the platform");
	assert.match(job, /runId: terminalCallback\.runId, attemptId: terminalCallback\.attemptId/u);
});

test("the in-container watchdog still bounds the run and reports the truth", () => {
	assert.match(job, /RUN_DEADLINE_MS = 300_000/u);
	assert.match(job, /run-deadline-exceeded/u);
	assert.match(worker, /AGENT_EXECUTION_TIMEOUT_MS = 330_000/u, "the SDK timeout sits strictly above the in-container deadline");
});

test("the agent is the bounded three-tool loop on the sol model, with frozen surfaces write-denied in code", () => {
	assert.match(agent, /const AGENT_MODEL = "gpt-5\.6-sol"/u);
	assert.match(agent, /read_file/u);
	assert.match(agent, /write_file/u);
	assert.match(agent, /list_dir/u);
	assert.match(agent, /WRITE_DENIED_PATHS/u);
	assert.match(agent, /\^platform\\\//u, "platform/ writes are denied in code");
	assert.match(agent, /\^\\\.github\\\//u, ".github/ writes are denied in code");
	assert.match(agent, /\^apps\\\//u, "the legacy demo (apps/) is write-denied: the product surface is product/ only");
	assert.match(job, /product surface is product\//u, "the agent instructions name the product surface");
	assert.match(agent, /reasoning\.encrypted_content/u, "reasoning items replay across tool calls");
});

test("mode budgets can only tighten the agent's ceiling, never widen it", () => {
	// The ceiling is the env-configurable constant; the per-dispatch budget is
	// clamped against it, so a hostile or buggy dispatch cannot buy more tools.
	assert.match(agent, /MAX_TOOL_CALLS_CEILING/u, "a ceiling exists independent of the dispatch");
	assert.match(agent, /Math\.min\(request\.maxToolCalls, MAX_TOOL_CALLS_CEILING\)/u, "the dispatch budget is clamped to the ceiling");
	assert.match(agent, /request\.effort === "low" \? "low" : "medium"/u, "only low is selectable; anything else is medium");
	// The model stays constant across modes: mode changes budgets, not brains.
	// The agent is handed resolved budgets (effort/maxToolCalls/includeTree/
	// selfReview) and never a mode name, so no code path can branch on mode.
	assert.doesNotMatch(agent, /request\.mode\b|request\.tier\b/u, "the agent receives resolved budgets, never a mode to branch on");
	assert.match(agent, /model: request\.model/u, "the model comes from the dispatch alone");
});

test("mode never relaxes a gate: local tests and the write firewall are mode-independent", () => {
	assert.match(job, /product\/test\/ui-contract\.test\.mjs/u, "the local gate always runs");
	assert.doesNotMatch(job, /mode[^\n]*ui-contract|ui-contract[^\n]*mode/u, "the local gate is never mode-conditional");
	assert.match(agent, /WRITE_DENIED_PATHS/u, "the write firewall is unconditional");
});

test("fast is a user choice the pipeline relays; nothing ever guesses cheap", () => {
	// The mode field flows dispatch -> worker request file -> job -> budgets.
	assert.match(worker, /mode === "fast" \? "fast" : "standard"/u, "the worker admits only a literal fast");
	assert.match(worker, /mode: dispatch\.mode/u, "the worker relays the validated mode into the job request");
	assert.match(job, /mode === "fast" \? "fast" : "standard"/u, "the job admits only a literal fast");
	assert.match(job, /MODE_BUDGETS\[request\.mode\] \?\? MODE_BUDGETS\.standard/u, "unknown modes take the standard budget");
	// No automatic sizing anywhere in the runner: the classifier is gone.
	for (const [name, source] of [["worker", worker], ["job", job], ["agent", agent]]) {
		assert.doesNotMatch(source, /classifyRunTier|TIER_BUDGETS/u, `${name} must not auto-size runs`);
	}
});

test("a fast pass labels itself honestly in the PR title and body", () => {
	assert.match(job, /request\.mode === "fast" \? `\$\{title\} \(fast pass\)` : title/u, "the title names the fast pass");
	assert.match(job, /Fast pass\./u, "the PR body explains the trade");
});

test("the terminal report records mode and effort for the run-timing fact", () => {
	assert.match(job, /mode: request\.mode, effort:/u, "mode and effort ride the terminal report");
});

test("the self-check gate runs before anything is committed, and fast only checks", () => {
	assert.match(agent, /SELF-CHECK PASS/u, "the agent audits its own staged diff against the request");
	assert.match(agent, /request\.selfReview === "check" \? "check" : "iterate"/u, "check is opt-in; iterate is the default");
	assert.match(agent, /allowTools: iterate/u, "only the iterating review may spend tools");
	assert.match(job, /selfReview: budgets\.selfReview/u, "the job resolves selfReview from the mode budget");
	// The iteration draws on the SAME ceilings as the main loop.
	assert.match(agent, /toolCalls < MAX_TOOL_CALLS/u, "the self-review spends remaining budget, never new budget");
});

test("the worker mints no tokens and stores no state: the dispatch carries the credential", () => {
	assert.doesNotMatch(worker, /createRunnerToken|GITHUB_APP|installation/u, "the platform mints the token, not the runner");
	assert.match(worker, /gitToken/u);
	assert.match(wrangler, /"AGENT_MODEL": "gpt-5\.6-sol"/u);
	assert.doesNotMatch(wrangler, /OPENAI_API_KEY/u, "the model credential is a secret, never a var");
});
