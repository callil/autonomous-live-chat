import { getSandbox, isDurableObjectCodeUpdateReset, isPlatformTransientError, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ALLOWED_REPOSITORY: string;
	APP_HARNESS_RUNNER_SECRET: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_INSTALLATION_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
	NATIVE_GIT_ENABLED: string;
};

type NativeGitJob = {
	jobId?: unknown;
	repository?: unknown;
	generation?: unknown;
	candidate?: unknown;
};

type CandidatePlan = {
	change: { kind: "documentation-patch"; patch: string };
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

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/;
const SHA = /^[0-9a-f]{40}$/i;
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function authorized(request: Request, env: Env): boolean {
	const value = request.headers.get("authorization");
	return value === `Bearer ${env.APP_HARNESS_RUNNER_SECRET}`;
}

function safeJob(input: NativeGitJob, env: Env): { jobId: string; repository: string; generation: number } | null {
	if (typeof input.jobId !== "string" || !JOB_ID.test(input.jobId)) return null;
	if (input.repository !== env.ALLOWED_REPOSITORY) return null;
	if (!Number.isInteger(input.generation) || (input.generation as number) < 1) return null;
	return { jobId: input.jobId, repository: input.repository, generation: input.generation as number };
}

function safeBranch(value: unknown): string | null {
	if (typeof value !== "string" || !BRANCH.test(value) || value.includes("..") || value.endsWith("/") || value.startsWith("-")) return null;
	return value;
}

function safeCandidate(input: unknown): CandidatePlan | null {
	if (!input || typeof input !== "object") return null;
	const candidate = input as Record<string, unknown>;
	const change = candidate.change;
	const stack = candidate.stack;
	if (!change || typeof change !== "object" || !stack || typeof stack !== "object") return null;
	const rawChange = change as Record<string, unknown>;
	const rawStack = stack as Record<string, unknown>;
	if (rawChange.kind !== "documentation-patch" || typeof rawChange.patch !== "string" || !safeDocumentationPatch(rawChange.patch)) return null;
	const stackId = typeof rawStack.stackId === "string" && JOB_ID.test(rawStack.stackId) ? rawStack.stackId : null;
	const nodeId = typeof rawStack.nodeId === "string" && JOB_ID.test(rawStack.nodeId) ? rawStack.nodeId : null;
	const branch = safeBranch(rawStack.branch);
	const parentBranch = safeBranch(rawStack.parentBranch);
	const pullRequestBase = safeBranch(rawStack.pullRequestBase);
	const parentBaseSha = rawStack.parentBaseSha === null ? null : typeof rawStack.parentBaseSha === "string" && SHA.test(rawStack.parentBaseSha) ? rawStack.parentBaseSha : undefined;
	const issueNumber = rawStack.issueNumber;
	if (!stackId || !nodeId || !branch || !parentBranch || !pullRequestBase || parentBaseSha === undefined || typeof issueNumber !== "number" || !Number.isInteger(issueNumber) || issueNumber < 1) return null;
	// A stack node can only target its immediate parent. The root is the sole
	// exception: it is based on main and receives its base SHA from checkout.
	if (pullRequestBase !== parentBranch || (parentBranch !== "main" && parentBaseSha === null)) return null;
	return {
		change: { kind: "documentation-patch", patch: rawChange.patch },
		stack: { stackId, nodeId, branch, parentBranch, parentBaseSha, pullRequestBase, issueNumber },
	};
}

/** A patch may affect only prose files. Reject path tricks and binary/git metadata. */
function safeDocumentationPatch(patch: string): boolean {
	if (!patch.startsWith("--- a/") || patch.length > 12_000 || /\0|\.\.\//u.test(patch)) return false;
	const paths = [...patch.matchAll(/^(?:--- a\/|\+\+\+ b\/)([^\n]+)$/gmu)].map((match) => match[1]);
	return paths.length >= 2 && paths.every((path) => path === "README.md" || (path.startsWith("docs/") && path.endsWith(".md")));
}

function classifyGitTransportFailure(stderr: string): "github-unreachable" | "github-authorization-rejected" | "github-upstream-unavailable" | "git-transport-failed" {
	// The raw transport output can include request context. Keep it inside the
	// Sandbox and expose only a small, auditable category to the coordinator.
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

async function runBoundedSandboxCleanup(action: () => Promise<unknown>, failureClassification: string): Promise<void> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const outcome = await Promise.race([
			action().then(() => "complete" as const, () => "failed" as const),
			new Promise<"timed-out">((resolve) => { timeout = setTimeout(() => resolve("timed-out"), SANDBOX_CLEANUP_TIMEOUT_MS); }),
		]);
		if (outcome !== "complete") console.warn("Sandbox cleanup did not complete", { classification: outcome === "timed-out" ? `${failureClassification}-timed-out` : failureClassification });
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

async function destroySandboxSafely(sandbox: ReturnType<typeof getSandbox>, sessionId?: string): Promise<void> {
	if (sessionId) {
		await runBoundedSandboxCleanup(() => sandbox.deleteSession(sessionId), "sandbox-session-cleanup-failed");
	}
	await runBoundedSandboxCleanup(() => sandbox.destroy(), "sandbox-destroy-failed");
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

type GitHubInstallationPreparation =
	| { token: string; classification?: never }
	| { token?: never; classification: "github-installation-unavailable" | "github-installation-rejected" | "github-repository-not-allowed" };

async function prepareGitHubInstallation(env: Env): Promise<GitHubInstallationPreparation> {
	try {
		const tokenResponse = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`, {
			method: "POST",
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${await appJwt(env)}`, "User-Agent": "app-harness-os-native-git", "X-GitHub-Api-Version": "2022-11-28" },
		});
		if (tokenResponse.status === 401 || tokenResponse.status === 403 || tokenResponse.status === 404) return { classification: "github-installation-rejected" };
		if (!tokenResponse.ok) return { classification: "github-installation-unavailable" };
		const token = (await tokenResponse.json() as { token?: unknown }).token;
		if (typeof token !== "string" || !token) return { classification: "github-installation-unavailable" };
		const repositoryResponse = await fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}`, {
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "app-harness-os-native-git", "X-GitHub-Api-Version": "2022-11-28" },
		});
		if (repositoryResponse.status === 401 || repositoryResponse.status === 403 || repositoryResponse.status === 404) return { classification: "github-repository-not-allowed" };
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

async function createStackPullRequest(
	env: Env,
	token: string,
	job: { repository: string; generation: number },
	candidate: CandidatePlan,
	headSha: string,
): Promise<{ url: string; number: number } | { classification: "pull-request-create-failed" }> {
	try {
		const existing = await fetch(`https://api.github.com/repos/${job.repository}/pulls?state=open&head=${encodeURIComponent(`callil:${candidate.stack.branch}`)}&base=${encodeURIComponent(candidate.stack.pullRequestBase)}`, {
			headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "User-Agent": "app-harness-os-native-git", "X-GitHub-Api-Version": "2022-11-28" },
		});
		if (existing.ok) {
			const pullRequests = await existing.json() as Array<{ html_url?: unknown; number?: unknown }>;
			const current = pullRequests[0];
			if (typeof current?.html_url === "string" && Number.isInteger(current.number)) return { url: current.html_url, number: current.number as number };
		}
		const response = await fetch(`https://api.github.com/repos/${job.repository}/pulls`, {
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "app-harness-os-native-git",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({
				title: "App Harness: documentation candidate",
				head: candidate.stack.branch,
				base: candidate.stack.pullRequestBase,
				body: [
					`Refs #${candidate.stack.issueNumber}`,
					"",
					"## Cloudflare OS candidate provenance",
					`- Stack: \`${candidate.stack.stackId}\` generation ${job.generation}`,
					`- Node: \`${candidate.stack.nodeId}\``,
					`- Parent base: \`${candidate.stack.parentBranch}\``,
					`- Candidate head: \`${headSha}\``,
					"- Runner applied only a validated README/docs unified patch, then ran the content checks.",
				].join("\n"),
			}),
		});
		if (!response.ok) return { classification: "pull-request-create-failed" };
		const pullRequest = (await response.json()) as { html_url?: unknown; number?: unknown };
		if (typeof pullRequest.html_url !== "string" || !Number.isInteger(pullRequest.number)) return { classification: "pull-request-create-failed" };
		return { url: pullRequest.html_url, number: pullRequest.number as number };
	} catch {
		return { classification: "pull-request-create-failed" };
	}
}

async function createSessionAfterRuntimeUpdate(
	sandbox: ReturnType<typeof getSandbox>,
	options: Parameters<ReturnType<typeof getSandbox>["createSession"]>[0],
) {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		try {
			return await sandbox.createSession(options);
		} catch (error) {
			const transient = isPlatformTransientError(error) || isDurableObjectCodeUpdateReset(error);
			if (!transient || attempt === 3) throw error;
			await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
		}
	}
	throw new Error("Sandbox session retry exhausted.");
}

/**
 * A deliberately tiny production Sandbox runner. The only currently live
	 * operation is a fixed command probe, used to verify isolated shell execution.
 *
 * The job endpoint uses a GitHub App private key held only by this Worker to
 * mint a short-lived installation token for the one allowed repository. The
 * token is never returned, logged, included in a command string, or sent to a
 * model/OS caller; only the isolated Sandbox Git process receives it.
 */
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method !== "POST" || !authorized(request, env)) {
			return new Response("Not found", { status: 404 });
		}

		if (url.pathname === "/v1/probe") {
			const sandbox = getSandbox(env.Sandbox, "app-harness-runner-probe", {
				enableDefaultSession: false,
			});
			try {
				const session = await createSessionAfterRuntimeUpdate(sandbox, { id: "probe", cwd: "/workspace", commandTimeoutMs: 15_000 });
				const result = await session.exec("git --version", { timeout: 15_000 });
				return Response.json({ ok: result.success, exitCode: result.exitCode, stdout: result.stdout.trim().slice(0, 160), runner: "cloudflare-sandbox" });
			} catch (error) {
				return Response.json({ ok: false, state: "runner-unavailable", classification: classifySandboxFailure(error) }, { status: 503 });
			} finally {
				await destroySandboxSafely(sandbox, "probe");
			}
		}

		if (url.pathname === "/v1/native-git/jobs") {
			let body: NativeGitJob;
			try {
				body = await request.json() as NativeGitJob;
			} catch {
				return Response.json({ error: "Invalid job payload." }, { status: 400 });
			}
			const job = safeJob(body, env);
			if (!job) return Response.json({ error: "Job is outside the runner's scope." }, { status: 403 });
			const candidate = body.candidate === undefined ? null : safeCandidate(body.candidate);
			if (body.candidate !== undefined && !candidate) {
				return Response.json({ error: "Candidate plan is outside the runner's fixed policy." }, { status: 403 });
			}
			if (env.NATIVE_GIT_ENABLED !== "true" || !env.GITHUB_APP_ID || !env.GITHUB_APP_INSTALLATION_ID || !env.GITHUB_APP_PRIVATE_KEY) {
				return Response.json({
					jobId: job.jobId,
					state: "credential-bridge-required",
					message: "The isolated runner is live, but native Git stays disabled until the repository-scoped GitHub App capability is configured.",
				});
			}
			const installation = await prepareGitHubInstallation(env);
			if ("classification" in installation) {
				return Response.json({ jobId: job.jobId, state: "checkout-failed", classification: installation.classification });
			}

			const sandbox = getSandbox(env.Sandbox, `app-harness-${job.jobId}-g${job.generation}`, { enableDefaultSession: false });
			// A retried HTTP request must not collide with an interrupted prior
			// attempt. The session ID is opaque and short lived; the durable job ID
			// remains the audit identity.
			const sessionId = `candidate-${job.generation}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
			const checkoutDirectory = `/workspace/${sessionId}-repository`;
			let session;
			try {
				session = await createSessionAfterRuntimeUpdate(sandbox, {
					id: sessionId,
					cwd: "/workspace",
					commandTimeoutMs: 120_000,
				});
			} catch (error) {
				await destroySandboxSafely(sandbox, sessionId);
				return Response.json({ jobId: job.jobId, state: "runner-unavailable", classification: classifySandboxFailure(error) });
			}
			try {
				// The SDK applies these only to this one process. The one-hour
				// installation token is never included in a command string, repository
				// URL, session-global environment, audit event, or response.
				const gitEnv = gitAuthorizationEnv(installation.token);
				const cloneBranch = candidate?.stack.parentBranch ?? "main";
				const clone = await session.exec(
					`git clone --depth 1 --branch ${cloneBranch} https://github.com/callil/autonomous-live-chat.git ${checkoutDirectory}`,
					{
						timeout: 120_000,
						env: gitEnv,
					},
				);
				if (!clone.success) {
					return Response.json({
						jobId: job.jobId,
						state: "checkout-failed",
						exitCode: clone.exitCode,
						classification: classifyGitTransportFailure(clone.stderr),
					});
				}
				const base = await session.exec(`git -C ${checkoutDirectory} rev-parse HEAD`, { timeout: 15_000 });
				const baseSha = base.stdout.trim();
				if (!base.success || !SHA.test(baseSha)) {
					return Response.json({ jobId: job.jobId, state: "checkout-failed", classification: "checkout-head-unavailable" });
				}
				if (!candidate) return Response.json({ jobId: job.jobId, state: "checked-out", head: baseSha, baseSha });
				if (candidate.stack.parentBaseSha && candidate.stack.parentBaseSha !== baseSha) {
					return Response.json({
						jobId: job.jobId,
						state: "needs-restack",
						baseSha,
						classification: "parent-base-sha-mismatch",
						stack: { id: candidate.stack.stackId, generation: job.generation, nodeId: candidate.stack.nodeId, parentBranch: candidate.stack.parentBranch },
					});
				}

				const patchPath = `${checkoutDirectory}/candidate.patch`;
				const patchWrite = await session.writeFile(patchPath, candidate.change.patch);
				if (!patchWrite.success) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: "candidate-patch-write-failed" });

				const commandStages: Array<[string, string, Record<string, string> | undefined]> = [
					["branch", `git -C ${checkoutDirectory} checkout -b ${candidate.stack.branch}`, undefined],
					["identity", `git -C ${checkoutDirectory} config user.name \"App Harness OS\"`, undefined],
					["identity", `git -C ${checkoutDirectory} config user.email \"app-harness-os@users.noreply.github.com\"`, undefined],
					["apply", `git -C ${checkoutDirectory} apply --whitespace=error-all candidate.patch`, undefined],
					["validate", `git -C ${checkoutDirectory} diff --check`, undefined],
					["policy", `git -C ${checkoutDirectory} diff --name-only | grep -E '^(README\\.md|docs/[^/]+\\.md)$'`, undefined],
					["stage", `git -C ${checkoutDirectory} add -- README.md docs`, undefined],
					["commit", `git -C ${checkoutDirectory} commit -m \"App Harness: update documentation\"`, undefined],
					// The branch name is derived solely from the durable stack ID, issue, and
					// generation. Retrying this same job may update only that same candidate.
					["push", `git -C ${checkoutDirectory} push --force --set-upstream origin ${candidate.stack.branch}`, gitEnv],
				];
				for (const [stage, command, commandEnv] of commandStages) {
					const result = await session.exec(command, { timeout: 120_000, ...(commandEnv ? { env: commandEnv } : {}) });
					if (!result.success) {
						return Response.json({ jobId: job.jobId, state: "candidate-failed", exitCode: result.exitCode, classification: `candidate-${stage}-failed` });
					}
				}
				const head = await session.exec(`git -C ${checkoutDirectory} rev-parse HEAD`, { timeout: 15_000 });
				const headSha = head.stdout.trim();
				if (!head.success || !SHA.test(headSha)) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: "candidate-head-unavailable" });
				const pullRequest = await createStackPullRequest(env, installation.token, job, candidate, headSha);
				if ("classification" in pullRequest) return Response.json({ jobId: job.jobId, state: "candidate-failed", classification: pullRequest.classification });
				return Response.json({
					jobId: job.jobId,
					state: "pull-request-opened",
					baseSha,
					headSha,
					pullRequest,
					stack: {
						id: candidate.stack.stackId,
						generation: job.generation,
						nodeId: candidate.stack.nodeId,
						branch: candidate.stack.branch,
						parentBranch: candidate.stack.parentBranch,
						pullRequestBase: candidate.stack.pullRequestBase,
					},
				});
			} finally {
				await destroySandboxSafely(sandbox, sessionId);
			}
		}

		return new Response("Not found", { status: 404 });
	},
};
