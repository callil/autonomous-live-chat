import { getSandbox, isDurableObjectCodeUpdateReset, isPlatformTransientError, type Sandbox } from "@cloudflare/sandbox";
import { WorkerEntrypoint } from "cloudflare:workers";

export { Sandbox } from "@cloudflare/sandbox";

/**
 * The platform's sandbox runner (ported from native-git-runner, with ALL
 * stack machinery removed). One disposable container per run: clone latest
 * main, create the plain room/<intentSeq>/<attempt> branch, run the bounded
 * coding agent, run local tests, commit with requester attribution trailers,
 * push, open a plain PR against main, and report {branch, prNumber, headSha}
 * by push to the platform's /api/runner/complete callback. The platform —
 * never this Worker — reads CI, merges, and observes the deploy.
 */

type RunnerEnv = {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ALLOWED_REPOSITORY: string;
	AGENT_MODEL?: string;
	PLATFORM_CALLBACK_URL?: string;
	SANDBOX_CLOUDFLARE_ACCOUNT_ID?: string;
	OPENAI_API_KEY?: string;
};

type RunnerDispatch = {
	runId?: unknown;
	attemptId?: unknown;
	intentId?: unknown;
	branch?: unknown;
	evidence?: unknown;
	feedUrl?: unknown;
	gitToken?: unknown;
	tier?: unknown;
};

type SafeDispatch = {
	runId: string;
	attemptId: string;
	intentId: string;
	branch: string;
	evidence: { requestText: string; requestedBy: string; annotations: unknown[] };
	feedUrl: string;
	gitToken: string;
	tier: "small" | "normal";
};

type DispatchResult = { accepted: true } | { accepted: false; reason: string };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u;
/** The one branch shape the platform names: plain room/<intentSeq>/<attempt> from latest main. */
const ROOM_BRANCH = /^room\/\d{1,12}\/[a-f0-9]{4,32}$/u;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;
const DEFAULT_AGENT_MODEL = "gpt-5.6-sol";
const RUNNER_IMAGE_REVISION = "platform-r1";
const MAX_REQUEST_TEXT_CHARS = 8_000;
const MAX_ANNOTATIONS = 20;
const MAX_REQUEST_FILE_BYTES = 512_000;
// The SDK-side process timeout MUST sit strictly above the in-container
// RUN_DEADLINE_MS (300s) plus the watchdog's emit-and-callback grace (~17s)
// so the in-container watchdog always gets to report the truth first.
const AGENT_EXECUTION_TIMEOUT_MS = 330_000;
const BOOT_VERIFICATION_TIMEOUT_MS = 15_000;
const BOOT_POLL_INTERVAL_MS = 1_000;
const BOOT_DIAGNOSTIC_TAIL_CHARS = 400;
const SANDBOX_CLEANUP_TIMEOUT_MS = 5_000;
const TERMINAL_PROCESS_STATUSES = new Set(["completed", "failed", "killed", "error"]);
const encoder = new TextEncoder();

async function deterministicId(scope: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${RUNNER_IMAGE_REVISION}:${scope}`)));
	// Sandbox IDs are DNS labels: lowercase hex only.
	const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `ahp-${hex.slice(0, 32)}`;
}

function safeDispatch(input: RunnerDispatch): SafeDispatch | null {
	const { runId, attemptId, intentId, branch, evidence, feedUrl, gitToken, tier } = input;
	if (typeof runId !== "string" || !IDENTIFIER.test(runId)) return null;
	if (typeof attemptId !== "string" || !IDENTIFIER.test(attemptId)) return null;
	if (typeof intentId !== "string" || !IDENTIFIER.test(intentId)) return null;
	if (typeof branch !== "string" || !ROOM_BRANCH.test(branch)) return null;
	if (typeof gitToken !== "string" || !gitToken.length || gitToken.length > 512) return null;
	if (typeof feedUrl !== "string" || !feedUrl.startsWith("https://") || feedUrl.length > 512) return null;
	if (!evidence || typeof evidence !== "object") return null;
	const { requestText, requestedBy, annotations } = evidence as Record<string, unknown>;
	if (typeof requestText !== "string" || typeof requestedBy !== "string" || !AUTHOR.test(requestedBy) || !Array.isArray(annotations)) return null;
	return {
		runId,
		attemptId,
		intentId,
		branch,
		evidence: { requestText: requestText.slice(0, MAX_REQUEST_TEXT_CHARS), requestedBy, annotations: annotations.slice(0, MAX_ANNOTATIONS) },
		feedUrl,
		gitToken,
		// An unrecognised or absent tier takes the normal budget: the runner
		// never guesses cheap.
		tier: tier === "small" ? "small" : "normal",
	};
}

function classifySandboxFailure(error: unknown): string {
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

async function createOrResumeSession(sandbox: ReturnType<typeof getSandbox>, sessionId: string) {
	try {
		return await sandbox.createSession({ id: sessionId, cwd: "/workspace", commandTimeoutMs: AGENT_EXECUTION_TIMEOUT_MS });
	} catch (error) {
		if (!/already exists|session.*exist/iu.test(error instanceof Error ? error.message : "")) throw error;
		return sandbox.getSession(sessionId);
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

/**
 * Disposable execution capability. The platform Room DO ledger owns all
 * lifecycle state; this Worker only boots a bounded sandbox process. Results
 * flow back exclusively through the job's push callback (runId as bearer,
 * attemptId as zombie guard) — a startRun acceptance only means "the job
 * process booted".
 */
export class PlatformRunner extends WorkerEntrypoint<RunnerEnv> {
	async startRun(input: RunnerDispatch): Promise<DispatchResult> {
		const dispatch = safeDispatch(input);
		if (!dispatch) return { accepted: false, reason: "dispatch-outside-contract" };
		if (!this.env.OPENAI_API_KEY) return { accepted: false, reason: "agent-credential-missing" };
		const callbackUrl = this.env.PLATFORM_CALLBACK_URL;
		if (!callbackUrl?.startsWith("https://")) return { accepted: false, reason: "callback-url-not-configured" };

		// The sandbox is per-run; the process identity is per-attempt, so a
		// retry can never attach to a prior attempt's corpse.
		const sandboxId = await deterministicId(dispatch.runId);
		const sessionId = `${sandboxId}-session`;
		const processId = `p-${dispatch.attemptId.replace(/[^a-z0-9-]/giu, "").toLowerCase().slice(0, 60)}`;
		const requestPath = `/tmp/${sandboxId}-request.json`;
		const checkoutDirectory = `/workspace/${processId}-repository`;

		const request = {
			repository: this.env.ALLOWED_REPOSITORY,
			runId: dispatch.runId,
			attemptId: dispatch.attemptId,
			intentId: dispatch.intentId,
			branch: dispatch.branch,
			evidence: dispatch.evidence,
			feedUrl: dispatch.feedUrl,
			model: this.env.AGENT_MODEL ?? DEFAULT_AGENT_MODEL,
			tier: dispatch.tier,
			checkoutDirectory,
			callback: { url: callbackUrl, runId: dispatch.runId, attemptId: dispatch.attemptId },
		};
		const serialized = JSON.stringify(request);
		if (encoder.encode(serialized).byteLength > MAX_REQUEST_FILE_BYTES) return { accepted: false, reason: "dispatch-evidence-too-large" };

		const sandbox = getSandbox(this.env.Sandbox, sandboxId, { enableDefaultSession: false });
		let session;
		try {
			session = await createOrResumeSession(sandbox, sessionId);
			const existing = await session.getProcess(processId).catch(() => null);
			if (existing) return TERMINAL_PROCESS_STATUSES.has(existing.status) ? { accepted: false, reason: "attempt-already-finished" } : { accepted: true };
		} catch (error) {
			return { accepted: false, reason: classifySandboxFailure(error) };
		}

		const write = await session.writeFile(requestPath, serialized);
		if (!write.success) return { accepted: false, reason: "runner-input-write-failed" };
		// A prior attempt in this sandbox may have left its boot marker behind;
		// an empty overwrite means only THIS attempt's write can satisfy boot.
		await session.writeFile(`${requestPath}.boot`, "").catch(() => null);

		const env: Record<string, string> = {
			...gitAuthorizationEnv(dispatch.gitToken),
			OPENAI_API_KEY: this.env.OPENAI_API_KEY,
			GH_TOKEN: dispatch.gitToken,
			GITHUB_TOKEN: dispatch.gitToken,
			GH_REPO: this.env.ALLOWED_REPOSITORY,
			CI: "true",
		};
		if (this.env.SANDBOX_CLOUDFLARE_ACCOUNT_ID) env.CLOUDFLARE_ACCOUNT_ID = this.env.SANDBOX_CLOUDFLARE_ACCOUNT_ID;
		try {
			await session.startProcess(`node /opt/app-harness/job-entrypoint.mjs ${requestPath}`, {
				cwd: "/workspace",
				env,
				processId,
				autoCleanup: false,
				timeout: AGENT_EXECUTION_TIMEOUT_MS,
			});
		} catch (error) {
			const existing = await session.getProcess(processId).catch(() => null);
			if (existing && !TERMINAL_PROCESS_STATUSES.has(existing.status)) return { accepted: true };
			return { accepted: false, reason: classifySandboxFailure(error) };
		}

		// Boot verification: the job writes `<requestPath>.boot` before any
		// other work, so a process that never produces the marker died before
		// its first line — an immediate classified refusal, never a silent run
		// the TTL has to catch ten minutes later.
		const bootDeadline = Date.now() + BOOT_VERIFICATION_TIMEOUT_MS;
		while (Date.now() < bootDeadline) {
			const marker = await session.readFile(`${requestPath}.boot`).catch(() => null);
			if (marker?.success && marker.content) return { accepted: true };
			const process = await session.getProcess(processId).catch(() => null);
			if (!process || TERMINAL_PROCESS_STATUSES.has(process.status)) break;
			await new Promise((resolve) => setTimeout(resolve, BOOT_POLL_INTERVAL_MS));
		}
		const dead = await session.getProcess(processId).catch(() => null);
		const logs = dead ? await dead.getLogs().catch(() => null) : null;
		await dead?.kill("SIGKILL").catch(() => null);
		// Reclaim the container slot: a sandbox whose job cannot boot will never
		// produce a callback, and the pool is bounded by max_instances.
		await destroySandboxSafely(sandbox, sessionId).catch(() => undefined);
		console.log(JSON.stringify({ event: "job-boot-failed", processId, exitCode: dead?.exitCode ?? null, stdout: logs?.stdout?.slice(-BOOT_DIAGNOSTIC_TAIL_CHARS) ?? null, stderr: logs?.stderr?.slice(-BOOT_DIAGNOSTIC_TAIL_CHARS) ?? null }));
		return { accepted: false, reason: "job-boot-failed" };
	}
}

export default { fetch(): Response { return new Response("Not found", { status: 404 }); } };
