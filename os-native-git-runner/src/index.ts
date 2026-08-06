import { getSandbox, isDurableObjectCodeUpdateReset, isPlatformTransientError, type Sandbox } from "@cloudflare/sandbox";
import {
	buildNanocodexInstructions,
	NANOCODEX_DEFAULT_MODEL,
	NANOCODEX_VERSION,
	normalizeAgentSummary,
	safeAgentFailure,
} from "./runner-contract.js";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ALLOWED_REPOSITORY: string;
	APP_HARNESS_RUNNER_SECRET: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_INSTALLATION_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	NATIVE_GIT_ENABLED: string;
	OPENAI_API_KEY: string;
	MODEL_ID?: string;
	SANDBOX_CLOUDFLARE_API_TOKEN?: string;
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

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const SHA = /^[0-9a-f]{40}$/iu;
const encoder = new TextEncoder();
const RUNNER_IMAGE_REVISION = "nc030-gs010";

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sandboxIdentity(scope: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`${RUNNER_IMAGE_REVISION}:${scope}`)));
	return `ah-${RUNNER_IMAGE_REVISION}-${base64Url(digest).slice(0, 32)}`;
}

function authorized(request: Request, env: Env): boolean {
	return request.headers.get("authorization") === `Bearer ${env.APP_HARNESS_RUNNER_SECRET}`;
}

function safeJob(input: NativeGitJob, env: Env): { jobId: string; repository: string; generation: number } | null {
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
	if (rawChange.kind !== "repository-task" || typeof rawChange.request !== "string" || !rawChange.request.trim() || rawChange.request.length > 500) return null;
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

function classifyGitTransportFailure(stderr: string): "github-unreachable" | "github-authorization-rejected" | "github-upstream-unavailable" | "git-transport-failed" {
	if (/could not resolve host|name or service not known|failed to connect|connection timed out/iu.test(stderr)) return "github-unreachable";
	if (/http (?:401|403|404)\b|authentication failed|could not read username/iu.test(stderr)) return "github-authorization-rejected";
	if (/http 5\d\d\b|service unavailable/iu.test(stderr)) return "github-upstream-unavailable";
	return "git-transport-failed";
}

function classifySandboxFailure(error: unknown): "sandbox-capacity-exhausted" | "sandbox-runtime-updating" | "sandbox-unavailable" {
	const message = error instanceof Error ? error.message : "";
	if (/maximum number of running container instances exceeded|max_instances/iu.test(message)) return "sandbox-capacity-exhausted";
	if (isPlatformTransientError(error) || isDurableObjectCodeUpdateReset(error)) return "sandbox-runtime-updating";
	return "sandbox-unavailable";
}

const SANDBOX_CLEANUP_TIMEOUT_MS = 5_000;
const NANOCODEX_EXECUTION_TIMEOUT_MS = 720_000;
const NANOCODEX_PROCESS_POLL_MS = 5_000;

type SandboxSession = Awaited<ReturnType<ReturnType<typeof getSandbox>["createSession"]>>;
type BackgroundExecution = {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	classification?: "sandbox-runtime-interrupted";
};

async function runNanocodexInBackground(
	session: SandboxSession,
	command: string,
	options: { cwd: string; env: Record<string, string>; processId: string },
	context: { jobId: string; generation: number },
): Promise<BackgroundExecution> {
	const process = await session.startProcess(command, {
		cwd: options.cwd,
		env: options.env,
		processId: options.processId,
		autoCleanup: false,
		timeout: NANOCODEX_EXECUTION_TIMEOUT_MS,
	});
	const startedAt = Date.now();
	let polls = 0;
	while (Date.now() - startedAt < NANOCODEX_EXECUTION_TIMEOUT_MS) {
		const current = await session.getProcess(process.id);
		if (!current) return { success: false, exitCode: 1, stdout: "", stderr: "", classification: "sandbox-runtime-interrupted" };
		const status = current.status;
		if (["completed", "failed", "killed", "error"].includes(status)) {
			const logs = await current.getLogs();
			const exitCode = current.exitCode ?? 1;
			const runtimeOutput = `${logs.stdout}\n${logs.stderr}`;
			const interrupted = status !== "completed" && exitCode !== 0 && (
				!runtimeOutput.trim()
				|| /new version rollout|runtime signalled the container to exit|sandbox (?:process )?(?:disappeared|was restarted)/iu.test(runtimeOutput)
			);
			return {
				success: status === "completed" && exitCode === 0,
				exitCode,
				stdout: logs.stdout,
				stderr: logs.stderr,
				...(interrupted ? { classification: "sandbox-runtime-interrupted" as const } : {}),
			};
		}
		polls += 1;
		if (polls === 1 || polls % 12 === 0) {
			console.log("NanoCodex background process active", {
				jobId: context.jobId,
				generation: context.generation,
				processId: process.id,
				elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000),
			});
		}
		await new Promise((resolve) => setTimeout(resolve, NANOCODEX_PROCESS_POLL_MS));
	}
	await process.kill("SIGTERM").catch(() => undefined);
	const logs = await process.getLogs().catch(() => ({ stdout: "", stderr: "" }));
	return { success: false, exitCode: 124, stdout: logs.stdout, stderr: logs.stderr || "NanoCodex execution timed out." };
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

function pemToDer(pem: string): ArrayBuffer {
	const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/gu, "").replace(/\s+/gu, "");
	const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function appJwt(env: Env): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
	const payload = base64Url(encoder.encode(JSON.stringify({ iat: now - 30, exp: now + 540, iss: env.GITHUB_APP_ID })));
	const key = await crypto.subtle.importKey("pkcs8", pemToDer(env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)));
	return `${header}.${payload}.${base64Url(signature)}`;
}

type Installation = { token: string; classification?: never } | { token?: never; classification: "github-installation-unavailable" | "github-installation-rejected" | "github-repository-not-allowed" };

async function prepareGitHubInstallation(env: Env): Promise<Installation> {
	try {
		const tokenResponse = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`, {
			method: "POST",
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await appJwt(env)}`, "User-Agent": "app-harness-nanocodex", "X-GitHub-Api-Version": "2026-03-10" },
		});
		if ([401, 403, 404].includes(tokenResponse.status)) return { classification: "github-installation-rejected" };
		if (!tokenResponse.ok) return { classification: "github-installation-unavailable" };
		const token = (await tokenResponse.json() as { token?: unknown }).token;
		if (typeof token !== "string" || !token) return { classification: "github-installation-unavailable" };
		const repositoryResponse = await fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}`, {
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "app-harness-nanocodex", "X-GitHub-Api-Version": "2026-03-10" },
		});
		if ([401, 403, 404].includes(repositoryResponse.status)) return { classification: "github-repository-not-allowed" };
		return repositoryResponse.ok ? { token } : { classification: "github-installation-unavailable" };
	} catch {
		return { classification: "github-installation-unavailable" };
	}
}

function gitAuthorizationEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.extraHeader",
		GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${token}`)}`,
		GIT_TERMINAL_PROMPT: "0",
	};
}

function githubHeaders(token: string): Record<string, string> {
	return { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "app-harness-nanocodex", "X-GitHub-Api-Version": "2026-03-10" };
}

function provenanceBody(existing: string, job: { generation: number }, candidate: CandidatePlan, headSha: string): string {
	const start = "<!-- app-harness-provenance:start -->";
	const end = "<!-- app-harness-provenance:end -->";
	const prior = existing.replace(new RegExp(`${start}[\\s\\S]*?${end}`, "u"), "").trim();
	return [
		prior || `Refs #${candidate.stack.issueNumber}`,
		"",
		start,
		"## App Harness candidate provenance",
		`- Stack: \`${candidate.stack.stackId}\` generation ${job.generation}`,
		`- Node: \`${candidate.stack.nodeId}\``,
		`- Parent base: \`${candidate.stack.parentBranch}\`${candidate.stack.parentBaseSha ? ` at \`${candidate.stack.parentBaseSha}\`` : ""}`,
		`- Candidate head: \`${headSha}\``,
		`- Operator: NanoCodex ${NANOCODEX_VERSION}`,
		"- CI is the merge and production deployment authority.",
		end,
	].join("\n");
}

async function findAndAnnotatePullRequest(token: string, job: { repository: string; generation: number }, candidate: CandidatePlan, headSha: string): Promise<{ url: string; number: number } | { classification: "candidate-pull-request-missing" | "pull-request-provenance-failed" }> {
	try {
		const owner = job.repository.split("/")[0];
		const response = await fetch(`https://api.github.com/repos/${job.repository}/pulls?state=open&head=${encodeURIComponent(`${owner}:${candidate.stack.branch}`)}&base=${encodeURIComponent(candidate.stack.pullRequestBase)}`, { headers: githubHeaders(token) });
		if (!response.ok) return { classification: "candidate-pull-request-missing" };
		const matches = await response.json() as Array<{ html_url?: unknown; number?: unknown; body?: unknown; head?: { sha?: unknown }; base?: { ref?: unknown } }>;
		const pullRequest = matches.find((item) => item.head?.sha === headSha && item.base?.ref === candidate.stack.pullRequestBase);
		if (!pullRequest || typeof pullRequest.html_url !== "string" || !Number.isInteger(pullRequest.number)) return { classification: "candidate-pull-request-missing" };
		const update = await fetch(`https://api.github.com/repos/${job.repository}/pulls/${pullRequest.number as number}`, {
			method: "PATCH",
			headers: githubHeaders(token),
			body: JSON.stringify({ body: provenanceBody(typeof pullRequest.body === "string" ? pullRequest.body : "", job, candidate, headSha) }),
		});
		if (!update.ok) return { classification: "pull-request-provenance-failed" };
		return { url: pullRequest.html_url, number: pullRequest.number as number };
	} catch {
		return { classification: "pull-request-provenance-failed" };
	}
}

async function createSessionAfterRuntimeUpdate(sandbox: ReturnType<typeof getSandbox>, options: Parameters<ReturnType<typeof getSandbox>["createSession"]>[0]) {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		try { return await sandbox.createSession(options); } catch (error) {
			if (!(isPlatformTransientError(error) || isDurableObjectCodeUpdateReset(error)) || attempt === 3) throw error;
			await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
		}
	}
	throw new Error("Sandbox session retry exhausted.");
}

function parseAgent(stdout: string, model: string): { summary: AgentSummary; ok: boolean; classification?: string } | null {
	if (stdout.length > 16_000) return null;
	try {
		const raw = JSON.parse(stdout.trim()) as Record<string, unknown>;
		const summary = normalizeAgentSummary(raw, model) as AgentSummary | null;
		if (!summary || summary.model !== model) return null;
		return { summary, ok: raw.ok === true, ...(raw.ok === true ? {} : { classification: safeAgentFailure(raw.classification) }) };
	} catch { return null; }
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || !authorized(request, env)) return new Response("Not found", { status: 404 });

		if (url.pathname === "/v1/probe") {
			// A versioned Sandbox identity prevents a surviving Durable Object from
			// serving the previous container image after a runner image release.
			const sandbox = getSandbox(env.Sandbox, await sandboxIdentity("probe"), { enableDefaultSession: false });
			try {
				const session = await createSessionAfterRuntimeUpdate(sandbox, { id: "probe", cwd: "/workspace", commandTimeoutMs: 20_000 });
				const result = await session.exec("git --version && nanocodex --version && gh stack --help >/dev/null", { timeout: 20_000 });
				return Response.json({ ok: result.success, exitCode: result.exitCode, stdout: result.stdout.trim().slice(0, 200), runner: "cloudflare-sandbox-nanocodex" });
			} catch (error) {
				return Response.json({ ok: false, state: "runner-unavailable", classification: classifySandboxFailure(error) }, { status: 503 });
			} finally { await destroySandboxSafely(sandbox, "probe"); }
		}

		if (url.pathname !== "/v1/native-git/jobs") return new Response("Not found", { status: 404 });
		let body: NativeGitJob;
		try { body = await request.json() as NativeGitJob; } catch { return Response.json({ error: "Invalid job payload." }, { status: 400 }); }
		const job = safeJob(body, env);
		if (!job) return Response.json({ error: "Job is outside the runner's scope." }, { status: 403 });
		const candidate = body.candidate === undefined ? null : safeCandidate(body.candidate);
		if (body.candidate !== undefined && !candidate) return Response.json({ error: "Candidate plan is outside the runner contract." }, { status: 403 });
		const model = env.MODEL_ID || NANOCODEX_DEFAULT_MODEL;
		if (env.NATIVE_GIT_ENABLED !== "true" || !env.GITHUB_APP_ID || !env.GITHUB_APP_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.OPENAI_API_KEY) {
			return Response.json({ jobId: job.jobId, state: "credential-bridge-required", message: "The isolated runner requires separately injected OpenAI and repository-scoped GitHub App capabilities." });
		}
		const installation = await prepareGitHubInstallation(env);
		if ("classification" in installation) return Response.json({ jobId: job.jobId, state: "checkout-failed", classification: installation.classification });

		const sandbox = getSandbox(env.Sandbox, await sandboxIdentity(`${job.jobId}:g${job.generation}`), { enableDefaultSession: false });
		const sessionId = `candidate-${job.generation}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
		const checkoutDirectory = `/workspace/${sessionId}-repository`;
		let session;
		try {
			session = await createSessionAfterRuntimeUpdate(sandbox, { id: sessionId, cwd: "/workspace", commandTimeoutMs: NANOCODEX_EXECUTION_TIMEOUT_MS });
		} catch (error) {
			await destroySandboxSafely(sandbox, sessionId);
			return Response.json({ jobId: job.jobId, state: "runner-unavailable", classification: classifySandboxFailure(error) });
		}

		try {
			const gitEnv = gitAuthorizationEnv(installation.token);
			const cloneBranch = candidate?.stack.parentBranch ?? "main";
			const clone = await session.exec(`git clone --branch ${cloneBranch} https://github.com/${job.repository}.git ${checkoutDirectory}`, { timeout: 120_000, env: gitEnv });
			if (!clone.success) return Response.json({ jobId: job.jobId, state: "checkout-failed", exitCode: clone.exitCode, classification: classifyGitTransportFailure(clone.stderr) });
			const base = await session.exec(`git -C ${checkoutDirectory} rev-parse HEAD`, { timeout: 15_000 });
			const baseSha = base.stdout.trim();
			if (!base.success || !SHA.test(baseSha)) return Response.json({ jobId: job.jobId, state: "checkout-failed", classification: "checkout-head-unavailable" });
			if (!candidate) return Response.json({ jobId: job.jobId, state: "checked-out", head: baseSha, baseSha });
			if (candidate.stack.parentBaseSha && candidate.stack.parentBaseSha !== baseSha) {
				return Response.json({ jobId: job.jobId, state: "needs-restack", baseSha, classification: "parent-base-sha-mismatch", stack: { id: candidate.stack.stackId, generation: job.generation, nodeId: candidate.stack.nodeId, parentBranch: candidate.stack.parentBranch } });
			}

			const remote = await session.exec(`git -C ${checkoutDirectory} ls-remote --heads origin refs/heads/${candidate.stack.branch}`, { timeout: 30_000, env: gitEnv });
			if (!remote.success) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: classifyGitTransportFailure(remote.stderr) });
			const remoteSha = remote.stdout.trim().split(/\s+/u)[0];
			const checkout = SHA.test(remoteSha)
				? await session.exec(`git -C ${checkoutDirectory} fetch origin refs/heads/${candidate.stack.branch}:refs/remotes/origin/${candidate.stack.branch} && git -C ${checkoutDirectory} checkout -B ${candidate.stack.branch} refs/remotes/origin/${candidate.stack.branch}`, { timeout: 120_000, env: gitEnv })
				: await session.exec(`git -C ${checkoutDirectory} checkout -b ${candidate.stack.branch}`, { timeout: 30_000 });
			if (!checkout.success) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: "candidate-branch-failed" });

			const agentEnv: Record<string, string> = {
				...gitEnv,
				OPENAI_API_KEY: env.OPENAI_API_KEY,
				OPENAI_MODEL: model,
				GH_TOKEN: installation.token,
				GITHUB_TOKEN: installation.token,
				GH_REPO: job.repository,
				CI: "true",
				NANOCODEX_VERSION,
			};
			if (env.SANDBOX_CLOUDFLARE_API_TOKEN) agentEnv.CLOUDFLARE_API_TOKEN = env.SANDBOX_CLOUDFLARE_API_TOKEN;
			if (env.SANDBOX_CLOUDFLARE_ACCOUNT_ID) agentEnv.CLOUDFLARE_ACCOUNT_ID = env.SANDBOX_CLOUDFLARE_ACCOUNT_ID;
			const prompt = `Implement the linked repository task exactly as requested: ${candidate.change.request}`;
			const instructions = buildNanocodexInstructions({ repository: job.repository, issueNumber: candidate.stack.issueNumber, branch: candidate.stack.branch, stackId: candidate.stack.stackId, generation: job.generation });
			const requestPath = `/tmp/${sessionId}-nanocodex-request.json`;
			const requestWrite = await session.writeFile(requestPath, JSON.stringify({ prompt, instructions, cwd: checkoutDirectory, model }));
			if (!requestWrite.success) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: "nanocodex-input-write-failed" });
			const execution = await runNanocodexInBackground(
				session,
				`node /opt/app-harness/agent-entrypoint.mjs < ${requestPath}`,
				{ cwd: checkoutDirectory, env: agentEnv, processId: `nanocodex-${sessionId}` },
				{ jobId: job.jobId, generation: job.generation },
			);
			if (execution.classification) {
				return Response.json({
					jobId: job.jobId,
					state: "runner-unavailable",
					classification: execution.classification,
					agent: { model, responseIds: [], tools: [] },
				});
			}
			const agent = parseAgent(execution.stdout, model);
			if (!execution.success || !agent?.ok) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: agent?.classification ?? "nanocodex-output-invalid", agent: agent?.summary ?? { model, responseIds: [], tools: [] } });

			const status = await session.exec(`git -C ${checkoutDirectory} status --porcelain`, { timeout: 15_000 });
			const head = await session.exec(`git -C ${checkoutDirectory} rev-parse HEAD`, { timeout: 15_000 });
			const headSha = head.stdout.trim();
			if (!status.success || status.stdout.trim()) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: "candidate-working-tree-dirty", agent: agent.summary });
			if (!head.success || !SHA.test(headSha) || headSha === baseSha) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: "candidate-head-unavailable", agent: agent.summary });
			const pushed = await session.exec(`git -C ${checkoutDirectory} ls-remote --heads origin refs/heads/${candidate.stack.branch}`, { timeout: 30_000, env: gitEnv });
			if (!pushed.success || pushed.stdout.trim().split(/\s+/u)[0] !== headSha) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: "candidate-head-not-pushed", agent: agent.summary });
			const pullRequest = await findAndAnnotatePullRequest(installation.token, job, candidate, headSha);
			if ("classification" in pullRequest) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: pullRequest.classification, agent: agent.summary });
			return Response.json({
				jobId: job.jobId,
				state: "pull-request-opened",
				baseSha,
				headSha,
				pullRequest,
				stack: { id: candidate.stack.stackId, generation: job.generation, nodeId: candidate.stack.nodeId, branch: candidate.stack.branch, parentBranch: candidate.stack.parentBranch, pullRequestBase: candidate.stack.pullRequestBase },
				agent: agent.summary,
			});
		} finally { await destroySandboxSafely(sandbox, sessionId); }
	},
};
