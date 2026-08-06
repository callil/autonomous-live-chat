import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

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
			const session = await sandbox.createSession({
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

			const sandbox = getSandbox(env.Sandbox, `app-harness-${job.jobId}-g${job.generation}`, { enableDefaultSession: false });
			const sessionId = `candidate-${job.generation}`;
			const session = await sandbox.createSession({ id: sessionId, cwd: "/workspace", commandTimeoutMs: 120_000 });
			try {
				// Configure Git directly rather than interpolating a shell variable into
				// the command. The short-lived assertion reaches only this session's
				// environment, never a command string, stderr, audit event, or response.
				await session.setEnvVars({
					GIT_CONFIG_COUNT: "1",
					GIT_CONFIG_KEY_0: "http.extraHeader",
					GIT_CONFIG_VALUE_0: `Authorization: Bearer ${await signedProxyAssertion(job, env.GIT_PROXY_ASSERTION_SECRET)}`,
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
						classification: "git-transport-failed",
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
