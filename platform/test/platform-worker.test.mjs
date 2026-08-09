import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const worker = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
const ports = await readFile(new URL("../src/ports.ts", import.meta.url), "utf8");
const github = await readFile(new URL("../src/github.ts", import.meta.url), "utf8");
const doctor = await readFile(new URL("../src/doctor.ts", import.meta.url), "utf8");
const wrangler = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const firewall = await readFile(new URL("../../.github/workflows/platform-firewall.yml", import.meta.url), "utf8");
const deployWorkflow = await readFile(new URL("../../.github/workflows/deploy-platform.yml", import.meta.url), "utf8");
const productDeploy = await readFile(new URL("../../.github/workflows/deploy-product.yml", import.meta.url), "utf8");
const provisionWorkflow = await readFile(new URL("../../.github/workflows/provision-runtime-secrets.yml", import.meta.url), "utf8");

test("the platform worker never imports the legacy operator machinery", () => {
	for (const source of [worker, ports, github]) {
		assert.doesNotMatch(source, /@app-harness\/(demo|operator|contracts)/u, "the rebuild ports patterns, not modules");
		assert.doesNotMatch(source, /apps\/demo|infra\/workers|infra\/orchestration/u);
		assert.doesNotMatch(source, /OperatorGateway|LedgerService|ChatRoom/u);
	}
});

test("owner levers fail closed on the ADMIN_TOKEN bearer secret", () => {
	assert.match(worker, /pathname\.startsWith\("\/api\/admin\/"\)/u);
	assert.match(worker, /if \(!token \|\| request\.headers\.get\("Authorization"\) !== `Bearer \$\{token\}`\) return new Response\("Unauthorized", \{ status: 401 \}\);/u);
	assert.match(worker, /"\/api\/admin\/freeze"/u);
	assert.match(worker, /"\/api\/admin\/revert"/u);
});

test("the runner callback is guarded by runId-as-bearer plus the attempt ID zombie guard", () => {
	assert.match(worker, /"\/api\/runner\/complete"/u);
	assert.match(worker, /assertLiveAttempt\(queue, \{ runId, attemptId \}\)/u);
	assert.match(worker, /outcome\.accepted \? 200 : 403/u);
});

test("pokes only set the dirty mark; the level-triggered reconciler drives the delta through decide()", () => {
	assert.match(worker, /async poke\(\)/u);
	assert.match(worker, /DIRTY_KEY, true/u);
	assert.match(worker, /RECONCILE_INTERVAL_MS = 60_000/u);
	// The alarm ALWAYS reconciles and then always reschedules itself: the loop
	// can never terminate, whatever cadence it picks.
	assert.match(worker, /await this\.reconcile\(\);\s*await this\.scheduleReconcile\(Date\.now\(\) \+ \(await this\.nextReconcileDelayMs\(\)\)\);/u, "the alarm reconciles then always reschedules");
	// The cadence is chosen from durable state and is never slower than the
	// steady floor: waiting on CI or a deploy polls tighter, idle falls back.
	assert.match(worker, /ACTIVE_RECONCILE_INTERVAL_MS = 5_000/u);
	assert.match(worker, /return RECONCILE_INTERVAL_MS;/u, "an idle room falls back to the steady cadence");
	assert.match(worker, /const actions = decide\(\{/u, "decisions come from the pure policy, not inline judgment");
});

test("webhook pokes are HMAC-verified and fail closed; even a verified poke decides nothing", () => {
	assert.match(worker, /verifyWebhookSignature\(env\.GITHUB_WEBHOOK_SECRET, body, request\.headers\.get\("X-Hub-Signature-256"\)\)/u);
	assert.match(worker, /if \(!verified\) return new Response\("Invalid signature", \{ status: 401 \}\);/u);
	assert.match(github, /crypto\.subtle\.verify\("HMAC", key, signature, encoder\.encode\(body\)\)/u, "constant-time verification via WebCrypto");
});

test("the runner port is the real service binding with an honest stub fallback", () => {
	assert.match(ports, /interface RunnerPort/u);
	assert.match(ports, /interface DoctorPort/u);
	assert.match(ports, /class BindingRunnerPort/u);
	assert.match(ports, /class StubRunnerPort/u);
	assert.match(ports, /class StubDoctorPort/u);
	assert.match(worker, /new BindingRunnerPort\(binding as RunnerBinding\) : new StubRunnerPort\(\)/u);
	assert.match(wrangler, /"binding": "RUNNER"/u);
	assert.match(wrangler, /"service": "app-harness-platform-runner"/u);
});

test("the Doctor is gpt-5.6-sol on park events only, constrained and fail-open (task #18)", () => {
	assert.match(worker, /env\.OPENAI_API_KEY \? new OpenAiDoctorPort\(env\.OPENAI_API_KEY\) : new StubDoctorPort\(\)/u, "no credential means the deterministic stub");
	assert.match(doctor, /"gpt-5\.6-sol"/u);
	assert.match(doctor, /text: \{ format: \{ type: "json_schema", name: "doctor_verdict", strict: true, schema: VERDICT_SCHEMA \} \}/u, "the verdict is schema-constrained on the API side");
	assert.doesNotMatch(doctor, /anthropic/iu, "the Anthropic code path is gone; the Doctor rides the runner's OpenAI key");
	assert.match(doctor, /enum: \["stay-parked", "retry-once"\]/u, "the output surface is exactly two dispositions plus a note");
	assert.match(doctor, /return this\.fallback\.consult\(caseFile\);/u, "every failure fails open to park-for-human");
	assert.match(doctor, /AbortSignal\.timeout\(DOCTOR_TIMEOUT_MS\)/u, "the consult is bounded");
	assert.match(ports, /RETRYABLE_DOCTOR_KINDS/u);
	assert.doesNotMatch(ports.slice(ports.indexOf("RETRYABLE_DOCTOR_KINDS")).split("]")[0], /deploy-ttl-exceeded|liveness/u, "a landed merge or a migration-crossed liveness failure can never be re-built");
	assert.match(doctor, /verdict\.disposition === "retry-once" && retryAvailable \? "retry-once" : "stay-parked"/u, "the mechanical clamp overrides the model");
});

test("park events queue durable Doctor cases; the reconciler consults and applies the verdict", () => {
	assert.match(worker, /DOCTOR_QUEUE_KEY = "doctor-queue"/u);
	assert.match(worker, /queueDoctorCase\(\{ kind: "ci-red"/u);
	assert.match(worker, /queueDoctorCase\(\{ kind: "merge-refused"/u);
	assert.match(worker, /queueDoctorCase\(\{ kind: "run-failed"/u);
	assert.match(worker, /queueDoctorCase\(\{ kind: "dispatch-refused"/u);
	assert.match(worker, /queueDoctorCase\(\{ kind: "liveness-failed-migration"/u);
	assert.match(worker, /case "consult-doctor": return this\.executeConsultDoctor\(now\);/u);
	assert.match(worker, /retryIntent\(intent, \{ runId, at: now \}\)/u, "retry-once re-queues the intent exactly once");
	assert.match(worker, /"intent-retried"/u);
	assert.match(worker, /if \(verdict\.disposition === "retry-once" && !retryAvailable\) verdict = \{ disposition: "stay-parked"/u, "the DO clamps the disposition again");
});

test("the pipeline merges at the exact verified head SHA and posts Live only on observation", () => {
	assert.match(github, /merge_method: "squash", sha: headSha/u, "the REST form of --match-head-commit");
	assert.match(worker, /squashMerge\(action\.prNumber, action\.headSha\)/u);
	assert.match(worker, /classifyCheckRuns\(await app\.listCheckRuns\(action\.headSha\)\)/u, "CI verdicts are read for the exact SHA and classified mechanically");
	assert.match(worker, /const observed = await observeDeployedVersion\(this\.env\.PRODUCT_URL\);\s*if \(observed !== action\.mergeSha\) return;/u, "merged completes only when /version serves the merge SHA");
	assert.match(worker, /const changedFiles = await app\.listChangedFiles\(action\.prNumber\);/u, "the diff is read from the merged PR");
	assert.match(worker, /includesMigrationMarker\(changedFiles\)/u, "the migration marker comes from the actual diff");
	assert.match(worker, /dispatchWorkflow\(DEPLOY_WORKFLOW_FILE/u);
	// Exactly one cause per deploy: the reconciler dispatches only when the
	// workflow's own push-on-product/** trigger will not already have fired.
	assert.match(worker, /const pushTriggerCovers = changedFiles\.some\(\(file\) => file\.startsWith\("product\/"\)\);/u);
	assert.match(worker, /if \(pushTriggerCovers\) return;/u, "no duplicate dispatch when the push trigger covers the merge");
	// The skip above is only correct while the workflow really does deploy on
	// pushes to main under product/**. If that filter ever changes, the
	// reconciler would stop dispatching for merges nothing else deploys, so
	// pin the two together here rather than discovering it as a parked run.
	assert.match(productDeploy, /push:\s*\n\s*branches: \[main\]\s*\n\s*paths:\s*\n\s*- "product\/\*\*"/u, "the push trigger the reconciler defers to still exists");
	assert.match(productDeploy, /group: app-harness-product-deploy\n/u, "deploys of different revisions stay strictly serialized");
});

test("the liveness watchdog reverts deterministically and refuses to cross migrations", () => {
	assert.match(worker, /syntheticLivenessCheck\(this\.env\.PRODUCT_URL\)/u);
	assert.match(worker, /WATCHDOG_WINDOW_MS = 5 \* 60_000/u);
	assert.match(worker, /if \(action\.migration \|\| !good\.previous\)/u, "auto-revert refuses when the deploy included a migration");
	assert.match(worker, /"rollback-requested"/u);
	assert.match(worker, /"rollback-observed"/u);
});

test("the deploy legs exist: platform deploy workflow, and the product deploy stamps /version with the exact SHA", () => {
	assert.match(deployWorkflow, /paths:\s*\n\s*- "platform\/\*\*"/u, "pushes to main touching platform/ deploy the platform");
	assert.match(deployWorkflow, /workflow_dispatch:/u);
	assert.match(deployWorkflow, /@app-harness\/platform-runner run deploy/u);
	assert.match(productDeploy, /inputs\.sha \|\| github\.sha/u, "the deploy leg accepts an exact SHA for merges and reverts");
	assert.match(productDeploy, /--var "DEPLOY_SHA:\$DEPLOY_SHA"/u, "the deployed revision is stamped into /version");
	assert.match(productDeploy, /git merge-base --is-ancestor/u, "only revisions reachable from main may deploy");
});

test("identity gates the room: signed session verified by the worker, forwarded to the DO, attached to the socket", () => {
	assert.match(worker, /if \(!env\.ADMIN_TOKEN\) return new Response\("Identity is not provisioned yet\.", \{ status: 503 \}\);/u, "sessions fail closed without the secret");
	assert.match(worker, /const identity = token \? await verifySessionToken\(env\.ADMIN_TOKEN, token\) : null;/u);
	assert.match(worker, /return new Response\("A signed session is required\.", \{ status: 401 \}\);/u, "the room WebSocket refuses anonymous upgrades");
	assert.match(worker, /server\.serializeAttachment\(\{ id, name \}/u, "identity survives hibernation on the socket attachment");
	assert.match(worker, /openedById: identity\.id/u, "attribution keys on the stable id, not the display name");
	assert.match(worker, /underOpenIntentLimit\(intents, identity\.id\)/u, "the open-intent cap keys on the stable id");
	assert.match(worker, /admitRateLimited\(this\.chatWindows, identity\.id/u, "chat is rate limited per stable id");
	assert.match(worker, /HttpOnly; SameSite=Lax/u, "the session cookie is HttpOnly");
	assert.doesNotMatch(worker, /message\.author/u, "client-supplied author names are gone; the session is the author");
});

test("the platform serves the frozen minimal fallback UI (task #13)", () => {
	assert.match(worker, /pathname === "\/fallback"/u);
	assert.match(worker, /FALLBACK_HTML/u);
	assert.match(wrangler, /app-harness-product\.coda-a\.workers\.dev/u, "the observed-deploy loop watches the PRODUCT worker, not the legacy demo");
});

test("the provisioning workflow owns the platform and runner secrets from repo-level Actions secrets", () => {
	for (const fragment of ["wrangler secret put ADMIN_TOKEN --name app-harness-platform", "wrangler secret put GITHUB_APP_PRIVATE_KEY --name app-harness-platform", "wrangler secret put GITHUB_WEBHOOK_SECRET --name app-harness-platform", "wrangler secret put OPENAI_API_KEY --name app-harness-platform", "wrangler secret put OPENAI_API_KEY --name app-harness-platform-runner"]) {
		assert.ok(provisionWorkflow.includes(fragment), fragment);
	}
	assert.ok(!provisionWorkflow.includes("ANTHROPIC"), "the Anthropic secret plumbing is gone; the Doctor rides APP_HARNESS_OPENAI_API_KEY");
});

test("the worker uses websocket hibernation, not in-memory socket bookkeeping", () => {
	assert.match(worker, /this\.ctx\.acceptWebSocket\(server\)/u);
	assert.match(worker, /this\.ctx\.getWebSockets\(\)/u);
	assert.doesNotMatch(worker, /addEventListener\("message"/u);
});

test("wrangler config declares the RoomDO as a new sqlite class with nodejs compat", () => {
	assert.match(wrangler, /"name": "app-harness-platform"/u);
	assert.match(wrangler, /"new_sqlite_classes":\s*\[\s*"RoomDO"\s*\]/u);
	assert.match(wrangler, /"nodejs_compat"/u);
	assert.match(wrangler, /ROOM_DAILY_BUDGET_USD/u);
	assert.doesNotMatch(wrangler, /ADMIN_TOKEN/u, "the admin token is a secret, never a var");
});

test("the firewall fails agent diffs touching platform, CI, manifests, lockfiles, or wrangler configs", () => {
	assert.match(firewall, /^on:\n  pull_request:$/mu);
	assert.match(firewall, /room\/\*\)/u, "only room/* agent branches are firewalled");
	assert.match(firewall, /platform\/\*/u);
	assert.match(firewall, /\.github\/\*/u);
	assert.match(firewall, /\*\/package\.json/u);
	assert.match(firewall, /\*\/package-lock\.json/u);
	assert.match(firewall, /pnpm-lock\.yaml/u);
	assert.match(firewall, /\*\/wrangler\.jsonc/u);
	assert.match(firewall, /wrangler\.toml/u);
	assert.match(firewall, /exit 1/u);
	assert.match(firewall, /persist-credentials: false/u);
});
