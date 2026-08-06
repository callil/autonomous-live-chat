import { getSandbox, isDurableObjectCodeUpdateReset, isPlatformTransientError, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ALLOWED_REPOSITORY: string;
	APP_HARNESS_RUNNER_SECRET: string;
	GIT_PROXY_ASSERTION_SECRET: string;
	GIT_PROXY_ORIGIN: string;
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

async function signedProxyAssertion(job: { jobId: string; repository: string; generation: number }, secret: string): Promise<string> {
	const payload = base64Url(encoder.encode(JSON.stringify({
		iss: "app-harness-os-native-git",
		jobId: job.jobId,
		repository: job.repository,
		generation: job.generation,
		exp: Math.floor(Date.now() / 1000) + 300,
	})));
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return `${payload}.${base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(payload))))}`;
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

function classifyGitTransportFailure(stderr: string): "proxy-unreachable" | "proxy-authorization-rejected" | "proxy-upstream-unavailable" | "git-transport-failed" {
	// The raw transport output can include request context. Keep it inside the
	// Sandbox and expose only a small, auditable category to the coordinator.
	if (/could not resolve host|name or service not known|failed to connect|connection timed out/iu.test(stderr)) return "proxy-unreachable";
	if (/http (?:401|403|404)\b|authentication failed|could not read username/iu.test(stderr)) return "proxy-authorization-rejected";
	if (/http 5\d\d\b|credential bridge unavailable|service unavailable/iu.test(stderr)) return "proxy-upstream-unavailable";
	return "git-transport-failed";
}

type ProxyPreparation =
	| { assertion: string; classification?: never }
	| { assertion?: never; classification: "proxy-unreachable" | "proxy-authorization-rejected" | "proxy-upstream-unavailable" | "proxy-discovery-rejected" };

async function prepareApprovedProxy(job: { jobId: string; repository: string; generation: number }, env: Env): Promise<ProxyPreparation> {
	const assertion = await signedProxyAssertion(job, env.GIT_PROXY_ASSERTION_SECRET);
	try {
		const response = await fetch(`${env.GIT_PROXY_ORIGIN}/${job.repository}.git/info/refs?service=git-upload-pack`, {
			headers: { Authorization: `Bearer ${assertion}`, "Git-Protocol": "version=2" },
		});
		if (response.ok) return { assertion };
		if (response.status === 401 || response.status === 403 || response.status === 404) return { classification: "proxy-authorization-rejected" };
		if (response.status >= 500) return { classification: "proxy-upstream-unavailable" };
		return { classification: "proxy-discovery-rejected" };
	} catch {
		return { classification: "proxy-unreachable" };
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
 * The job endpoint is intentionally fail-closed until a separately deployed
 * GitHub App installation-token proxy exists. It does not fabricate Git work.
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
			if (env.NATIVE_GIT_ENABLED !== "true" || !env.GIT_PROXY_ASSERTION_SECRET) {
				return Response.json({
					jobId: job.jobId,
					state: "credential-bridge-required",
					message: "The isolated runner is live, but native Git stays disabled until the repository-scoped GitHub App proxy is configured.",
				});
			}
			if (env.GIT_PROXY_ORIGIN !== "https://app-harness-os-git-proxy.coda-a.workers.dev") {
				return Response.json({ error: "Runner Git proxy origin is not approved." }, { status: 503 });
			}
			const proxy = await prepareApprovedProxy(job, env);
			if ("classification" in proxy) {
				return Response.json({ jobId: job.jobId, state: "checkout-failed", classification: proxy.classification });
			}

			const sandbox = getSandbox(env.Sandbox, `app-harness-${job.jobId}-g${job.generation}`, { enableDefaultSession: false });
			// A retried HTTP request must not collide with an interrupted prior
			// attempt. The session ID is opaque and short lived; the durable job ID
			// remains the audit identity.
			const sessionId = `candidate-${job.generation}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
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
				// Configure Git directly rather than interpolating a shell variable into
				// the command. The short-lived assertion reaches only this session's
				// environment, never a command string, stderr, audit event, or response.
				await session.setEnvVars({
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${proxy.assertion}`,
				});
				const clone = await session.exec(
					"git clone --depth 1 https://app-harness-os-git-proxy.coda-a.workers.dev/callil/autonomous-live-chat.git /workspace/repository",
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
				const head = await session.exec("git -C /workspace/repository rev-parse HEAD", { timeout: 15_000 });
				return Response.json({ jobId: job.jobId, state: "checked-out", head: head.stdout.trim().slice(0, 64) });
			} finally {
				await sandbox.deleteSession(sessionId);
			}
		}

		return new Response("Not found", { status: 404 });
	},
};
