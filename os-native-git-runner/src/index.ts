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
};

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
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

function classifyGitTransportFailure(stderr: string): "github-unreachable" | "github-authorization-rejected" | "github-upstream-unavailable" | "git-transport-failed" {
	// The raw transport output can include request context. Keep it inside the
	// Sandbox and expose only a small, auditable category to the coordinator.
	if (/could not resolve host|name or service not known|failed to connect|connection timed out/iu.test(stderr)) return "github-unreachable";
	if (/http (?:401|403|404)\b|authentication failed|could not read username/iu.test(stderr)) return "github-authorization-rejected";
	if (/http 5\d\d\b|service unavailable/iu.test(stderr)) return "github-upstream-unavailable";
	return "git-transport-failed";
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
 * operation is a fixed command probe, used to verify isolated shell execution
 * without accepting a repository URL, shell text, model output, or credential.
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
			const session = await createSessionAfterRuntimeUpdate(sandbox, {
				id: "probe",
				cwd: "/workspace",
				commandTimeoutMs: 15_000,
			});
			const result = await session.exec("git --version", { timeout: 15_000 });
			await sandbox.deleteSession("probe");
			return Response.json({
				ok: result.success,
				exitCode: result.exitCode,
				stdout: result.stdout.trim().slice(0, 160),
				runner: "cloudflare-sandbox",
			});
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
				session = await createSessionAfterRuntimeUpdate(sandbox, { id: sessionId, cwd: "/workspace", commandTimeoutMs: 120_000 });
			} catch (error) {
				if (isPlatformTransientError(error) || isDurableObjectCodeUpdateReset(error)) {
					return Response.json({ jobId: job.jobId, state: "runner-unavailable", classification: "sandbox-runtime-updating" });
				}
				throw error;
			}
			try {
				// Configure Git directly rather than interpolating a credential into a
				// command. The one-hour installation token reaches only this session's
				// environment, never a command string, audit event, or response.
				await session.setEnvVars({
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x-access-token:${installation.token}`)}`,
					GIT_TERMINAL_PROMPT: "0",
				});
				const clone = await session.exec(
					`git clone --depth 1 https://github.com/callil/autonomous-live-chat.git ${checkoutDirectory}`,
					{ timeout: 120_000 },
				);
				if (!clone.success) {
					return Response.json({
						jobId: job.jobId,
						state: "checkout-failed",
						exitCode: clone.exitCode,
						classification: classifyGitTransportFailure(clone.stderr),
					});
				}
				const head = await session.exec(`git -C ${checkoutDirectory} rev-parse HEAD`, { timeout: 15_000 });
				return Response.json({ jobId: job.jobId, state: "checked-out", head: head.stdout.trim().slice(0, 64) });
			} finally {
				await sandbox.deleteSession(sessionId);
			}
		}

		return new Response("Not found", { status: 404 });
	},
};
