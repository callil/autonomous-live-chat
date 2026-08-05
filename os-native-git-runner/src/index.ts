import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

export { Sandbox } from "@cloudflare/sandbox";

type Env = {
	Sandbox: DurableObjectNamespace<Sandbox>;
	ALLOWED_REPOSITORY: string;
	APP_HARNESS_RUNNER_SECRET: string;
};

type NativeGitJob = {
	jobId?: unknown;
	repository?: unknown;
	generation?: unknown;
};

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

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
			return Response.json({
				jobId: job.jobId,
				state: "credential-bridge-required",
				message: "The isolated runner is live, but it will not clone or push until the repository-scoped GitHub App proxy is configured.",
			});
		}

		return new Response("Not found", { status: 404 });
	},
};
