import { getSandbox, isDurableObjectCodeUpdateReset, isPlatformTransientError, type Sandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";
import { AGENT_DEFAULT_MODEL, buildAgentInstructions, normalizeAgentSummary, safeAgentFailure } from "./runner-contract.js";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
	Sandbox: DurableObjectNamespace<Sandbox>;
	GITHUB_APP: {
		createRunnerToken(input: { repository: string; jobId: string; generation: number }): Promise<{ token: string; expiresAt: string }>;
	};
	ALLOWED_REPOSITORY: string;
	NATIVE_GIT_ENABLED: string;
	OPENAI_API_KEY: string;
	SANDBOX_CLOUDFLARE_ACCOUNT_ID?: string;
	LEDGER_CALLBACK_URL?: string;
	AGENT_MODEL?: string;
};

type NativeGitJob = { jobId?: unknown; repository?: unknown; generation?: unknown; candidate?: unknown; ledgerRunId?: unknown };
type CandidatePlan = {
	change: { kind: "repository-task"; request: string; ciProfile?: string };
	stack: {
		stackId: string;
		nodeId: string;
		branch: string;
		parentBranch: string;
		parentBaseSha: string | null;
		pullRequestBase: string;
		issueNumber: number;
		/** The exact branch order beneath this node in the room's shared stack, from the ledger's record; empty for a root node. */
		expectedOrder: string[];
	};
};
type AgentSummary = { model: string; responseIds: string[]; tools: string[] };
type SafeJob = { jobId: string; repository: string; generation: number };
type RunIds = { sandboxId: string; sessionId: string; runId: string; checkoutDirectory: string; requestPath: string };

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const SHA = /^[0-9a-f]{40}$/iu;
/** A sibling parent inside the room stack is always a canonical node branch. */
const STACK_PARENT = /^app-harness-os\/\d+\/g\d+$/u;
/** Bounded, well above the room's implement slots: the stack can never grow this deep. */
const EXPECTED_ORDER_MAX = 16;
const RUNNER_IMAGE_REVISION = "da052-async015";
// The SDK-side process timeout. This MUST sit strictly above the in-container
// RUN_DEADLINE_MS (300s) plus the watchdog's emit-and-callback grace (~17s):
// when the two were equal, the platform SIGKILL always beat the in-container
// watchdog and every over-budget run died with no artifact, no callback, and
// no deadline classification — the exact silent-failure signature this
// revision removes.
const AGENT_EXECUTION_TIMEOUT_MS = 330_000;
// The Worker's own backstop, past every in-container watchdog. If a process is
// still non-terminal this long after it started, the container-side deadlines
// have all failed to fire and the run is wedged for good.
const RUNNER_DEADLINE_GRACE_MS = 120_000;
// The job writes `<requestPath>.boot` before any other work. startRun polls
// for it so a job process that dies before its first line is an immediate,
// classified implement-time error rather than a silent five-minute hang.
const BOOT_VERIFICATION_TIMEOUT_MS = 15_000;
const BOOT_POLL_INTERVAL_MS = 1_000;
const BOOT_DIAGNOSTIC_TAIL_CHARS = 400;
const SANDBOX_CLEANUP_TIMEOUT_MS = 5_000;
// Generous cap: the artifact is the last thing written after a potentially
// chatty run, and a low cap silently discarded it.
const MAX_ARTIFACT_STDOUT_CHARS = 200_000;
const TERMINAL_PROCESS_STATUSES = new Set(["completed", "failed", "killed", "error"]);
const TERMINAL_RUN_STATES = new Set(["checked-out", "needs-restack", "checkout-failed", "candidate-failed", "pull-request-opened"]);
const encoder = new TextEncoder();

async function deterministicId(scope: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${RUNNER_IMAGE_REVISION}:${scope}`)));
	// Sandbox IDs are DNS labels: lowercase hex only, so the identifier can
	// never begin or end with a hyphen or contain an underscore.
	const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `ah-${RUNNER_IMAGE_REVISION}-${hex.slice(0, 32)}`;
}

async function runIds(job: SafeJob): Promise<RunIds> {
	const stable = await deterministicId(`${job.jobId}:g${job.generation}`);
	return {
		sandboxId: stable,
		sessionId: `${stable}-session`,
		runId: `${stable}-run`,
		checkoutDirectory: `/workspace/${stable}-repository`,
		requestPath: `/tmp/${stable}-request.json`,
	};
}

function startedMarkerPath(ids: RunIds): string {
	return `${ids.requestPath}.started`;
}

function bootMarkerPath(ids: RunIds): string {
	return `${ids.requestPath}.boot`;
}

/**
 * Age of the run in milliseconds, derived from the marker startRun persisted.
 * Returns null when the marker is missing or unparseable so a missing marker
 * can never be mistaken for an infinitely old run.
 */
async function runAgeMs(session: { readFile(path: string): Promise<{ success: boolean; content?: string }> }, ids: RunIds): Promise<number | null> {
	const marker = await session.readFile(startedMarkerPath(ids)).catch(() => null);
	if (!marker?.success || typeof marker.content !== "string") return null;
	const startedAt = Date.parse(marker.content.trim());
	if (!Number.isFinite(startedAt)) return null;
	return Math.max(0, Date.now() - startedAt);
}

function safeJob(input: NativeGitJob, env: Env): SafeJob | null {
	if (typeof input.jobId !== "string" || !JOB_ID.test(input.jobId) || input.repository !== env.ALLOWED_REPOSITORY) return null;
	if (!Number.isInteger(input.generation) || (input.generation as number) < 1) return null;
	return { jobId: input.jobId, repository: input.repository, generation: input.generation as number };
}

function safeBranch(value: unknown): string | null {
	if (typeof value !== "string" || !BRANCH.test(value) || value.includes("..") || value.endsWith("/") || value.startsWith("-")) return null;
	return value;
}

function safeCandidate(input: unknown): CandidatePlan | null {
	if (!input || typeof input !== "object") return null;
	const { change, stack } = input as Record<string, unknown>;
	if (!change || typeof change !== "object" || !stack || typeof stack !== "object") return null;
	const rawChange = change as Record<string, unknown>;
	const rawStack = stack as Record<string, unknown>;
	if (rawChange.kind !== "repository-task" || typeof rawChange.request !== "string" || !rawChange.request.trim()) return null;
	const stackId = typeof rawStack.stackId === "string" && JOB_ID.test(rawStack.stackId) ? rawStack.stackId : null;
	const nodeId = typeof rawStack.nodeId === "string" && JOB_ID.test(rawStack.nodeId) ? rawStack.nodeId : null;
	const branch = safeBranch(rawStack.branch);
	const parentBranch = safeBranch(rawStack.parentBranch);
	const pullRequestBase = safeBranch(rawStack.pullRequestBase);
	const parentBaseSha = rawStack.parentBaseSha === null ? null : typeof rawStack.parentBaseSha === "string" && SHA.test(rawStack.parentBaseSha) ? rawStack.parentBaseSha : undefined;
	const issueNumber = rawStack.issueNumber;
	const expectedOrder = safeExpectedOrder(rawStack.expectedOrder);
	if (!stackId || !nodeId || !branch || !parentBranch || !pullRequestBase || parentBaseSha === undefined || !expectedOrder || !Number.isInteger(issueNumber) || (issueNumber as number) < 1) return null;
	if (pullRequestBase !== parentBranch || (parentBranch !== "main" && parentBaseSha === null)) return null;
	return {
		change: { kind: "repository-task", request: rawChange.request.trim(), ciProfile: typeof rawChange.ciProfile === "string" ? rawChange.ciProfile : undefined },
		stack: { stackId, nodeId, branch, parentBranch, parentBaseSha, pullRequestBase, issueNumber: issueNumber as number, expectedOrder },
	};
}

/** The exact branch order beneath this node, from the ledger's room-stack record; absent means empty (the root case). */
function safeExpectedOrder(value: unknown): string[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > EXPECTED_ORDER_MAX) return null;
	const order = value.map(safeBranch);
	return order.every((entry): entry is string => entry !== null) ? order : null;
}

/**
 * A canonical durable stack-node plan: the root node stacks on main with
 * nothing beneath it; a dependent node stacks on a pinned canonical sibling,
 * targets that parent, and knows the exact branch order below it.
 */
function isCanonicalStackNode(candidate: CandidatePlan, generation: number): boolean {
	const stack = candidate.stack;
	if (stack.parentBaseSha === null || stack.branch !== `app-harness-os/${stack.issueNumber}/g${generation}`) return false;
	if (stack.parentBranch === "main") {
		return stack.nodeId === "root" && stack.pullRequestBase === "main" && stack.expectedOrder.length === 0;
	}
	return stack.nodeId !== "root"
		&& STACK_PARENT.test(stack.parentBranch)
		&& stack.pullRequestBase === stack.parentBranch
		&& stack.expectedOrder.at(-1) === stack.parentBranch;
}

function classifySandboxFailure(error: unknown): "sandbox-capacity-exhausted" | "sandbox-runtime-updating" | "sandbox-unavailable" {
	const message = error instanceof Error ? error.message : "";
	if (/maximum number of running container instances exceeded|max_instances/iu.test(message)) return "sandbox-capacity-exhausted";
	if (isPlatformTransientError(error) || isDurableObjectCodeUpdateReset(error)) return "sandbox-runtime-updating";
	return "sandbox-unavailable";
}

function gitAuthorizationEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

async function createOrResumeSession(sandbox: ReturnType<typeof getSandbox>, ids: RunIds) {
	try {
		return await sandbox.createSession({ id: ids.sessionId, cwd: "/workspace", commandTimeoutMs: AGENT_EXECUTION_TIMEOUT_MS });
	} catch (error) {
		if (!/already exists|session.*exist/iu.test(error instanceof Error ? error.message : "")) throw error;
		return sandbox.getSession(ids.sessionId);
	}
}

async function runBoundedSandboxCleanup(action: () => Promise<unknown>, classification: string): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcome = await Promise.race([
			action().then(() => "complete" as const, () => "failed" as const),
			new Promise<"timed-out">((resolve) => { timeout = setTimeout(() => resolve("timed-out"), SANDBOX_CLEANUP_TIMEOUT_MS); }),
		]);
		if (outcome !== "complete") console.warn("Sandbox cleanup did not complete", { classification: `${classification}-${outcome}` });
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function destroySandboxSafely(sandbox: ReturnType<typeof getSandbox>, sessionId?: string): Promise<void> {
	if (sessionId) await runBoundedSandboxCleanup(() => sandbox.deleteSession(sessionId), "sandbox-session-cleanup");
	await runBoundedSandboxCleanup(() => sandbox.destroy(), "sandbox-destroy");
}

function parseTerminalArtifact(stdout: string, job: SafeJob, model: string): Record<string, unknown> | null {
	if (stdout.length > MAX_ARTIFACT_STDOUT_CHARS) return null;
	// Scan backwards for the last parseable artifact rather than demanding the
	// very last line be JSON: a trailing newline, a stray banner, or any late
	// non-JSON output would otherwise discard a perfectly good terminal
	// artifact and mislabel the run as producing invalid output.
	const lines = stdout.trim().split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index].trim();
		if (!line.startsWith("{")) continue;
		const parsed = parseArtifactLine(line, job, model);
		if (parsed) return parsed;
	}
	return null;
}

function parseArtifactLine(line: string, job: SafeJob, model: string): Record<string, unknown> | null {
	const raw = safeParse(line);
	if (!raw) return null;
	if (raw.jobId !== job.jobId || typeof raw.state !== "string" || !TERMINAL_RUN_STATES.has(raw.state)) return null;
	const result: Record<string, unknown> = { jobId: job.jobId, state: raw.state };
	for (const key of ["baseSha", "headSha"] as const) if (typeof raw[key] === "string" && SHA.test(raw[key])) result[key] = raw[key];
	if (typeof raw.classification === "string") result.classification = safeAgentFailure(raw.classification);
	if (raw.agent && typeof raw.agent === "object") {
		const agent = normalizeAgentSummary(raw.agent, model) as AgentSummary | null;
		if (agent) result.agent = agent;
	}
	if (raw.pullRequest && typeof raw.pullRequest === "object") {
		const pullRequest = raw.pullRequest as Record<string, unknown>;
		if (typeof pullRequest.number === "number" && Number.isSafeInteger(pullRequest.number) && pullRequest.number > 0 && typeof pullRequest.url === "string" && /^https:\/\/github\.com\//u.test(pullRequest.url)) result.pullRequest = { number: pullRequest.number, url: pullRequest.url };
	}
	if (raw.stack && typeof raw.stack === "object") {
		const stack = raw.stack as Record<string, unknown>;
		const topology = stack.topology as Record<string, unknown> | undefined;
		if (
			typeof stack.id === "string" && JOB_ID.test(stack.id)
			&& typeof stack.nodeId === "string" && JOB_ID.test(stack.nodeId)
			&& typeof stack.branch === "string" && safeBranch(stack.branch)
			&& typeof stack.parentBranch === "string" && (stack.parentBranch === "main" || STACK_PARENT.test(stack.parentBranch))
			&& topology?.trunk === "main"
			&& topology.branch === stack.branch
			&& typeof topology.baseSha === "string" && SHA.test(topology.baseSha)
		) result.stack = { id: stack.id, generation: job.generation, nodeId: stack.nodeId, branch: stack.branch, parentBranch: stack.parentBranch, topology: { trunk: "main", branch: stack.branch, baseSha: topology.baseSha.toLowerCase() } };
	}
	return result;
}

function safeParse(line: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(line) as unknown;
		return value && typeof value === "object" ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function probeRequest(): Request {
	return new Request("https://runner.internal/v1/probe", { method: "POST" });
}

const internalHandler = {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/probe") return new Response("Not found", { status: 404 });
		const sandbox = getSandbox(env.Sandbox, await deterministicId("probe"), { enableDefaultSession: false });
		try {
			const session = await sandbox.createSession({ id: "probe", cwd: "/workspace", commandTimeoutMs: 20_000 });
			const result = await session.exec("git --version && node --version && gh stack --help >/dev/null", { timeout: 20_000 });
			return Response.json({ ok: result.success, exitCode: result.exitCode, stdout: result.stdout.trim().slice(0, 200), runner: "cloudflare-sandbox-direct-agent" });
		} catch (error) {
			return Response.json({ ok: false, state: "runner-unavailable", classification: classifySandboxFailure(error) }, { status: 503 });
		} finally {
			await destroySandboxSafely(sandbox, "probe");
		}
	},
};

/**
 * Disposable execution capability. The durable App Harness ledger owns all
 * lifecycle state; this Worker only starts, inspects, or cancels a deterministic
 * Sandbox process. A retry of startRun returns the same run identifier.
 */
export class NativeGitRunner extends WorkerEntrypoint<Env> {
	async startRun(input: NativeGitJob): Promise<Record<string, unknown>> {
		const job = safeJob(input, this.env);
		const candidate = input.candidate === undefined ? null : safeCandidate(input.candidate);
		if (!job || (input.candidate !== undefined && !candidate)) throw new Error("Native Git job is outside the runner contract.");
		if (candidate && !isCanonicalStackNode(candidate, job.generation)) throw new Error("Native Git runner accepts only a canonical durable stack-node plan (root on main, or a dependent node on a pinned sibling with its expected order).");
		const ids = await runIds(job);
		// Model retirements are a recurring platform failure mode; an env var
		// makes the swap a config redeploy instead of an image rebuild.
		const model = this.env.AGENT_MODEL ?? AGENT_DEFAULT_MODEL;
		// The sandbox and branch identities stay deterministic (idempotency lives
		// in the ledger), but every attempt gets its OWN process identity: the
		// sandbox DO persists process records, so a deterministic process id made
		// retries attach to a prior attempt's corpse instead of spawning at all.
		const ledgerRunId = typeof input.ledgerRunId === "string" && JOB_ID.test(input.ledgerRunId) ? input.ledgerRunId : null;
		const processId = `p-${(ledgerRunId ?? crypto.randomUUID()).toLowerCase()}`;
		if (this.env.NATIVE_GIT_ENABLED !== "true" || !this.env.OPENAI_API_KEY) return { jobId: job.jobId, runId: processId, state: "credential-bridge-required" };

		const sandbox = getSandbox(this.env.Sandbox, ids.sandboxId, { enableDefaultSession: false });
		let session;
		try {
			session = await createOrResumeSession(sandbox, ids);
			const existing = await session.getProcess(processId).catch(() => null);
			if (existing) return { jobId: job.jobId, runId: processId, state: TERMINAL_PROCESS_STATUSES.has(existing.status) ? "finished" : "running" };
		} catch (error) {
			return { jobId: job.jobId, runId: processId, state: "runner-unavailable", classification: classifySandboxFailure(error) };
		}

		let token: string;
		try {
			({ token } = await this.env.GITHUB_APP.createRunnerToken({ repository: job.repository, jobId: job.jobId, generation: job.generation }));
		} catch {
			return { jobId: job.jobId, runId: processId, state: "checkout-failed", classification: "github-installation-unavailable" };
		}
		const instructions = candidate ? buildAgentInstructions({ repository: job.repository, issueNumber: candidate.stack.issueNumber, branch: candidate.stack.branch, stackId: candidate.stack.stackId, generation: job.generation }) : "Inspect the repository checkout only.";
		// The ledger's per-run identifier rides into the container as the bearer
		// credential for the completion callback; a run without one stays silent.
		const callback = ledgerRunId && this.env.LEDGER_CALLBACK_URL?.startsWith("https://")
			? { url: this.env.LEDGER_CALLBACK_URL, workItemId: job.jobId, runId: ledgerRunId }
			: null;
		// The checkout is per-attempt, like the process: a killed attempt leaves
		// a non-empty clone behind in the same deterministic sandbox, and git
		// refuses to clone into it - the retry must get a fresh directory.
		const checkoutDirectory = `/workspace/${processId}-repository`;
		// Simple copy and visual changes get a faster reasoning effort; the
		// heavier profiles keep the default.
		const effort = candidate && ["content", "visual"].includes(candidate.change?.ciProfile ?? "") ? "low" : "medium";
		const request = { job, candidate, model, effort, runId: processId, checkoutDirectory, instructions, callback };
		const write = await session.writeFile(ids.requestPath, JSON.stringify(request));
		if (!write.success) return { jobId: job.jobId, runId: processId, state: "runner-unavailable", classification: "runner-input-write-failed" };
		// Persist the start marker so inspectRun can derive run age. A failed
		// write is not fatal: it only costs the Worker-side backstop, and the
		// in-container watchdogs still bound the run.
		await session.writeFile(startedMarkerPath(ids), new Date().toISOString()).catch(() => null);
		// A prior attempt in this sandbox may have left its marker behind; an
		// empty overwrite means only THIS attempt's write can satisfy boot.
		await session.writeFile(bootMarkerPath(ids), "").catch(() => null);
		const env: Record<string, string> = {
			...gitAuthorizationEnv(token),
			OPENAI_API_KEY: this.env.OPENAI_API_KEY,
			GH_TOKEN: token,
			GITHUB_TOKEN: token,
			GH_REPO: job.repository,
			CI: "true",
		};
		if (this.env.SANDBOX_CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = this.env.SANDBOX_CLOUDFLARE_ACCOUNT_ID;
		try {
			await session.startProcess(`node /opt/app-harness/job-entrypoint.mjs ${ids.requestPath}`, {
				cwd: "/workspace",
				env,
				processId,
				autoCleanup: false,
				timeout: AGENT_EXECUTION_TIMEOUT_MS,
			});
		} catch (error) {
			const existing = await session.getProcess(processId).catch(() => null);
			if (existing) return { jobId: job.jobId, runId: processId, state: TERMINAL_PROCESS_STATUSES.has(existing.status) ? "finished" : "running" };
			return { jobId: job.jobId, runId: processId, state: "runner-unavailable", classification: classifySandboxFailure(error) };
		}

		// Boot verification: the job writes `<requestPath>.boot` before ANY other
		// work, so a process that never produces the marker died before its first
		// line (or never spawned). That is reported here, immediately, as a
		// classified failure with whatever the SDK exposes about the process —
		// never as a silent run that hangs until a five-minute backstop.
		const bootDeadline = Date.now() + BOOT_VERIFICATION_TIMEOUT_MS;
		let bootProcessStatus = "unknown";
		while (Date.now() < bootDeadline) {
			const marker = await session.readFile(bootMarkerPath(ids)).catch(() => null);
			if (marker?.success && marker.content) return { jobId: job.jobId, runId: processId, state: "running" };
			const process = await session.getProcess(processId).catch(() => null);
			bootProcessStatus = process?.status ?? "missing";
			// A terminal process with no boot marker can never boot later: stop
			// polling and report the diagnostics right away.
			if (!process || TERMINAL_PROCESS_STATUSES.has(process.status)) break;
			await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_INTERVAL_MS));
		}
		const dead = await session.getProcess(processId).catch(() => null);
		const logs = dead ? await dead.getLogs().catch(() => null) : null;
		await dead?.kill("SIGKILL").catch(() => null);
		// Reclaim the container slot immediately: a sandbox whose job cannot even
		// boot will never produce an artifact, and the pool is bounded to the
		// wrangler.jsonc max_instances (currently 8).
		await destroySandboxSafely(sandbox, ids.sessionId).catch(() => undefined);
		// The dead process's own words are the diagnosis: put them on the tail
		// stream where an operator (human or agent) can actually read them.
		console.log(JSON.stringify({ event: "job-boot-failed", processId, bootProcessStatus, exitCode: dead?.exitCode ?? null, stdout: logs?.stdout?.slice(-BOOT_DIAGNOSTIC_TAIL_CHARS) ?? null, stderr: logs?.stderr?.slice(-BOOT_DIAGNOSTIC_TAIL_CHARS) ?? null }));
		return {
			jobId: job.jobId,
			runId: processId,
			state: "candidate-failed",
			classification: "job-boot-failed",
			boot: {
				processStatus: dead?.status ?? bootProcessStatus,
				exitCode: dead?.exitCode ?? null,
				stdoutTail: (logs?.stdout ?? "").slice(-BOOT_DIAGNOSTIC_TAIL_CHARS),
				stderrTail: (logs?.stderr ?? "").slice(-BOOT_DIAGNOSTIC_TAIL_CHARS),
			},
		};
	}

	async inspectRun(input: { jobId: string; generation: number; runId: string }): Promise<Record<string, unknown>> {
		const job = safeJob({ jobId: input.jobId, repository: this.env.ALLOWED_REPOSITORY, generation: input.generation }, this.env);
		if (!job) throw new Error("Native Git inspection is outside the runner contract.");
		const ids = await runIds(job);
		const sandbox = getSandbox(this.env.Sandbox, ids.sandboxId, { enableDefaultSession: false });
		try {
			const session = await sandbox.getSession(ids.sessionId);
			const process = await session.getProcess(ids.runId);
			if (!process) return { jobId: job.jobId, runId: ids.runId, state: "runner-unavailable", classification: "sandbox-process-missing" };
			if (!TERMINAL_PROCESS_STATUSES.has(process.status)) {
				// Backstop: past this age every in-container watchdog has failed to
				// fire, so the run is wedged. Kill it and report the truth rather than
				// reporting "running" forever. SIGKILL and this branch are both
				// idempotent: a repeat inspection kills an already-dead process
				// harmlessly and returns the same terminal answer.
				const age = await runAgeMs(session, ids);
				if (age === null || age <= AGENT_EXECUTION_TIMEOUT_MS + RUNNER_DEADLINE_GRACE_MS) return { jobId: job.jobId, runId: ids.runId, state: "running" };
				await process.kill("SIGKILL").catch(() => null);
				// Reclaim the container slot. wrangler.jsonc bounds the pool
				// (max_instances, currently 8) and startProcess runs with
				// autoCleanup: false, so wedged sandboxes would otherwise
				// exhaust runner capacity permanently. The
				// artifact was already read from a killed process, so destroying the
				// sandbox here costs nothing and is safe to repeat.
				await destroySandboxSafely(sandbox, ids.sessionId).catch(() => undefined);
				return { jobId: job.jobId, runId: ids.runId, state: "candidate-failed", classification: "runner-deadline-enforced" };
			}
			const logs = await process.getLogs();
			const artifact = parseTerminalArtifact(logs.stdout, job, AGENT_DEFAULT_MODEL);
			return artifact ? { ...artifact, runId: ids.runId } : { jobId: job.jobId, runId: ids.runId, state: "candidate-failed", classification: "agent-output-invalid" };
		} catch (error) {
			return { jobId: job.jobId, runId: ids.runId, state: "runner-unavailable", classification: classifySandboxFailure(error) };
		}
	}

	async cancelRun(input: { jobId: string; generation: number; runId: string }): Promise<{ jobId: string; runId: string; state: "cancelled" | "finished" }> {
		const job = safeJob({ jobId: input.jobId, repository: this.env.ALLOWED_REPOSITORY, generation: input.generation }, this.env);
		if (!job) throw new Error("Native Git cancellation is outside the runner contract.");
		const ids = await runIds(job);
		const sandbox = getSandbox(this.env.Sandbox, ids.sandboxId, { enableDefaultSession: false });
		const session = await sandbox.getSession(ids.sessionId);
		const process = await session.getProcess(ids.runId);
		if (!process || TERMINAL_PROCESS_STATUSES.has(process.status)) return { jobId: job.jobId, runId: ids.runId, state: "finished" };
		await process.kill("SIGTERM");
		return { jobId: job.jobId, runId: ids.runId, state: "cancelled" };
	}

	async probe(): Promise<unknown> {
		const response = await internalHandler.fetch(probeRequest(), this.env);
		return response.json();
	}
}

export default { fetch(): Response { return new Response("Not found", { status: 404 }); } };
