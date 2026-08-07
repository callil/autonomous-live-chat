import { getSandbox, isDurableObjectCodeUpdateReset, isPlatformTransientError, type Sandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";
import { buildNanocodexInstructions, NANOCODEX_DEFAULT_MODEL, normalizeAgentSummary, safeAgentFailure } from "./runner-contract.js";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
	Sandbox: DurableObjectNamespace<Sandbox>;
	GITHUB_APP: {
		createRunnerToken(input: { repository: string; jobId: string; generation: number }): Promise<{ token: string; expiresAt: string }>;
	};
	ALLOWED_REPOSITORY: string;
	NATIVE_GIT_ENABLED: string;
	OPENAI_API_KEY: string;
	MODEL_ID?: string;
	SANDBOX_CLOUDFLARE_ACCOUNT_ID?: string;
};

type NativeGitJob = { jobId?: unknown; repository?: unknown; generation?: unknown; candidate?: unknown };
type CandidatePlan = {
	change: { kind: "repository-task"; request: string };
	stack: {
		stackId: string;
		nodeId: string;
		branch: string;
		parentBranch: string;
		parentBaseSha: string | null;
		pullRequestBase: string;
		issueNumber: number;
	};
};
type AgentSummary = { model: string; responseIds: string[]; tools: string[] };
type SafeJob = { jobId: string; repository: string; generation: number };
type RunIds = { sandboxId: string; sessionId: string; runId: string; checkoutDirectory: string; requestPath: string };

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const SHA = /^[0-9a-f]{40}$/iu;
const RUNNER_IMAGE_REVISION = "nc031-async010";
const NANOCODEX_EXECUTION_TIMEOUT_MS = 720_000;
const SANDBOX_CLEANUP_TIMEOUT_MS = 5_000;
const TERMINAL_PROCESS_STATUSES = new Set(["completed", "failed", "killed", "error"]);
const TERMINAL_RUN_STATES = new Set(["checked-out", "needs-restack", "checkout-failed", "candidate-failed", "pull-request-opened"]);
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function deterministicId(scope: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${RUNNER_IMAGE_REVISION}:${scope}`)));
	return `ah-${RUNNER_IMAGE_REVISION}-${base64Url(digest).slice(0, 32)}`;
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
	if (!stackId || !nodeId || !branch || !parentBranch || !pullRequestBase || parentBaseSha === undefined || !Number.isInteger(issueNumber) || (issueNumber as number) < 1) return null;
	if (pullRequestBase !== parentBranch || (parentBranch !== "main" && parentBaseSha === null)) return null;
	return {
		change: { kind: "repository-task", request: rawChange.request.trim() },
		stack: { stackId, nodeId, branch, parentBranch, parentBaseSha, pullRequestBase, issueNumber: issueNumber as number },
	};
}

function isOneNodeStack(candidate: CandidatePlan, generation: number): boolean {
	return candidate.stack.nodeId === "root"
		&& candidate.stack.parentBranch === "main"
		&& candidate.stack.pullRequestBase === "main"
		&& candidate.stack.parentBaseSha !== null
		&& candidate.stack.branch === `app-harness-os/${candidate.stack.issueNumber}/g${generation}`;
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
		return await sandbox.createSession({ id: ids.sessionId, cwd: "/workspace", commandTimeoutMs: NANOCODEX_EXECUTION_TIMEOUT_MS });
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
	if (stdout.length > 32_000) return null;
	const line = stdout.trim().split("\n").at(-1);
	if (!line) return null;
	try {
		const raw = JSON.parse(line) as Record<string, unknown>;
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
				&& stack.nodeId === "root"
				&& typeof stack.branch === "string" && safeBranch(stack.branch)
				&& stack.parentBranch === "main"
				&& topology?.trunk === "main"
				&& topology.branch === stack.branch
				&& typeof topology.baseSha === "string" && SHA.test(topology.baseSha)
			) result.stack = { id: stack.id, generation: job.generation, nodeId: "root", branch: stack.branch, parentBranch: "main", topology: { trunk: "main", branch: stack.branch, baseSha: topology.baseSha.toLowerCase() } };
		}
		return result;
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
			const result = await session.exec("git --version && nanocodex --version && gh stack --help >/dev/null", { timeout: 20_000 });
			return Response.json({ ok: result.success, exitCode: result.exitCode, stdout: result.stdout.trim().slice(0, 200), runner: "cloudflare-sandbox-nanocodex" });
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
		if (candidate && !isOneNodeStack(candidate, job.generation)) throw new Error("Native Git runner currently accepts only the durable one-node root stack plan.");
		const ids = await runIds(job);
		const model = this.env.MODEL_ID || NANOCODEX_DEFAULT_MODEL;
		if (this.env.NATIVE_GIT_ENABLED !== "true" || !this.env.OPENAI_API_KEY) return { jobId: job.jobId, runId: ids.runId, state: "credential-bridge-required" };

		const sandbox = getSandbox(this.env.Sandbox, ids.sandboxId, { enableDefaultSession: false });
		let session;
		try {
			session = await createOrResumeSession(sandbox, ids);
			const existing = await session.getProcess(ids.runId).catch(() => null);
			if (existing) return { jobId: job.jobId, runId: ids.runId, state: TERMINAL_PROCESS_STATUSES.has(existing.status) ? "finished" : "running" };
		} catch (error) {
			return { jobId: job.jobId, runId: ids.runId, state: "runner-unavailable", classification: classifySandboxFailure(error) };
		}

		let token: string;
		try {
			({ token } = await this.env.GITHUB_APP.createRunnerToken({ repository: job.repository, jobId: job.jobId, generation: job.generation }));
		} catch {
			return { jobId: job.jobId, runId: ids.runId, state: "checkout-failed", classification: "github-installation-unavailable" };
		}
		const instructions = candidate ? buildNanocodexInstructions({ repository: job.repository, issueNumber: candidate.stack.issueNumber, branch: candidate.stack.branch, stackId: candidate.stack.stackId, generation: job.generation }) : "Inspect the repository checkout only.";
		const request = { job, candidate, model, runId: ids.runId, checkoutDirectory: ids.checkoutDirectory, instructions };
		const write = await session.writeFile(ids.requestPath, JSON.stringify(request));
		if (!write.success) return { jobId: job.jobId, runId: ids.runId, state: "runner-unavailable", classification: "runner-input-write-failed" };
		const env: Record<string, string> = {
			...gitAuthorizationEnv(token),
			OPENAI_API_KEY: this.env.OPENAI_API_KEY,
			OPENAI_MODEL: model,
			GH_TOKEN: token,
			GITHUB_TOKEN: token,
			GH_REPO: job.repository,
			CI: "true",
		};
		if (this.env.SANDBOX_CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = this.env.SANDBOX_CLOUDFLARE_ACCOUNT_ID;
		try {
			await session.startProcess(`node /opt/app-harness/job-entrypoint.mjs < ${ids.requestPath}`, {
				cwd: "/workspace",
				env,
				processId: ids.runId,
				autoCleanup: false,
				timeout: NANOCODEX_EXECUTION_TIMEOUT_MS,
			});
			return { jobId: job.jobId, runId: ids.runId, state: "running" };
		} catch (error) {
			const existing = await session.getProcess(ids.runId).catch(() => null);
			if (existing) return { jobId: job.jobId, runId: ids.runId, state: TERMINAL_PROCESS_STATUSES.has(existing.status) ? "finished" : "running" };
			return { jobId: job.jobId, runId: ids.runId, state: "runner-unavailable", classification: classifySandboxFailure(error) };
		}
	}

	async inspectRun(input: { jobId: string; generation: number; runId: string }): Promise<Record<string, unknown>> {
		const job = safeJob({ jobId: input.jobId, repository: this.env.ALLOWED_REPOSITORY, generation: input.generation }, this.env);
		if (!job) throw new Error("Native Git inspection is outside the runner contract.");
		const ids = await runIds(job);
		if (input.runId !== ids.runId) throw new Error("Native Git inspection does not match the deterministic run identifier.");
		const sandbox = getSandbox(this.env.Sandbox, ids.sandboxId, { enableDefaultSession: false });
		try {
			const session = await sandbox.getSession(ids.sessionId);
			const process = await session.getProcess(ids.runId);
			if (!process) return { jobId: job.jobId, runId: ids.runId, state: "runner-unavailable", classification: "sandbox-process-missing" };
			if (!TERMINAL_PROCESS_STATUSES.has(process.status)) return { jobId: job.jobId, runId: ids.runId, state: "running" };
			const logs = await process.getLogs();
			const artifact = parseTerminalArtifact(logs.stdout, job, this.env.MODEL_ID || NANOCODEX_DEFAULT_MODEL);
			return artifact ? { ...artifact, runId: ids.runId } : { jobId: job.jobId, runId: ids.runId, state: "candidate-failed", classification: "nanocodex-output-invalid" };
		} catch (error) {
			return { jobId: job.jobId, runId: ids.runId, state: "runner-unavailable", classification: classifySandboxFailure(error) };
		}
	}

	async cancelRun(input: { jobId: string; generation: number; runId: string }): Promise<{ jobId: string; runId: string; state: "cancelled" | "finished" }> {
		const job = safeJob({ jobId: input.jobId, repository: this.env.ALLOWED_REPOSITORY, generation: input.generation }, this.env);
		if (!job) throw new Error("Native Git cancellation is outside the runner contract.");
		const ids = await runIds(job);
		if (input.runId !== ids.runId) throw new Error("Native Git cancellation does not match the deterministic run identifier.");
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
