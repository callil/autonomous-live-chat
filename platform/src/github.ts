/**
 * The platform's own GitHub App capability, ported from the github-bridge
 * worker and deliberately NARROW: mint installation tokens, read a PR's
 * check runs and changed files, squash-merge at an exact head SHA, dispatch
 * the deploy workflow, and read the deployed product's /version endpoint.
 * The App private key lives only in this Worker's secrets; nothing here
 * writes issues, labels, or comments.
 */

const encoder = new TextEncoder();
const GIT_SHA = /^[0-9a-f]{40}$/u;
const SIGNATURE_HEADER = /^sha256=([0-9a-f]{64})$/u;
const GITHUB_FETCH_TIMEOUT_MS = 20_000;
const VERSION_FETCH_TIMEOUT_MS = 10_000;

export type GitHubAppConfig = {
	repository: string;
	appId: string;
	installationId: string;
	privateKey: string;
};

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function pemToDer(pem: string): ArrayBuffer {
	const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/gu, "").replace(/\s+/gu, "");
	const bytes = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function githubHeaders(token: string): HeadersInit {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": "app-harness-platform",
		"x-github-api-version": "2022-11-28",
	};
}

function bounded(init?: RequestInit): RequestInit {
	return { ...init, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) };
}

/** Constant-time HMAC-SHA-256 verification of a raw GitHub webhook delivery body. */
export async function verifyWebhookSignature(secret: string | undefined, body: string, header: string | null): Promise<boolean> {
	if (!secret || typeof header !== "string") return false;
	const match = SIGNATURE_HEADER.exec(header);
	if (!match) return false;
	const digest = match[1];
	const signature = new Uint8Array(32);
	for (let index = 0; index < 32; index += 1) signature[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
	// crypto.subtle.verify performs the constant-time comparison itself.
	return crypto.subtle.verify("HMAC", key, signature, encoder.encode(body));
}

export class GitHubApp {
	private readonly config: GitHubAppConfig;

	constructor(config: GitHubAppConfig) {
		this.config = config;
	}

	private async appJwt(): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
		const payload = base64Url(encoder.encode(JSON.stringify({ iat: now - 30, exp: now + 540, iss: this.config.appId })));
		const key = await crypto.subtle.importKey("pkcs8", pemToDer(this.config.privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
		const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)));
		return `${header}.${payload}.${base64Url(signature)}`;
	}

	/** Short-lived installation token — also handed to the sandboxed runner as its Git credential. */
	async installationToken(): Promise<string> {
		const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(this.config.installationId)}/access_tokens`, bounded({
			method: "POST",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${await this.appJwt()}`,
				"user-agent": "app-harness-platform",
				"x-github-api-version": "2022-11-28",
			},
		}));
		if (!response.ok) throw new Error(`GitHub App installation token request failed (${response.status}).`);
		const body = await response.json() as { token?: unknown };
		if (typeof body.token !== "string" || !body.token) throw new Error("GitHub App returned no installation token.");
		return body.token;
	}

	/** Every check run GitHub recorded for the exact head SHA, for mechanical classification. */
	async listCheckRuns(headSha: string): Promise<Array<{ name: string; status: string; conclusion: string | null }>> {
		if (!GIT_SHA.test(headSha)) throw new Error("Check-run observation requires a full lowercase Git SHA.");
		const response = await fetch(`https://api.github.com/repos/${this.config.repository}/commits/${headSha}/check-runs?per_page=100`, bounded({ headers: githubHeaders(await this.installationToken()) }));
		if (!response.ok) throw new Error(`GitHub check-run observation failed (${response.status}).`);
		const body = await response.json() as { check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown }> };
		return (body.check_runs ?? []).map((run) => ({
			name: typeof run.name === "string" ? run.name : "unnamed-check",
			status: typeof run.status === "string" ? run.status : "unknown",
			conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
		}));
	}

	/** First page of a PR's changed files — bounded input for the deterministic migration marker. */
	async listChangedFiles(prNumber: number): Promise<string[]> {
		if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("Changed-file observation requires a PR number.");
		const response = await fetch(`https://api.github.com/repos/${this.config.repository}/pulls/${prNumber}/files?per_page=100`, bounded({ headers: githubHeaders(await this.installationToken()) }));
		if (!response.ok) throw new Error(`GitHub changed-file observation failed (${response.status}).`);
		const body = await response.json() as Array<{ filename?: unknown }>;
		return (Array.isArray(body) ? body : []).flatMap((file) => (typeof file.filename === "string" ? [file.filename] : []));
	}

	/**
	 * The exact-SHA squash merge (the API's sha parameter is the REST form of
	 * `--match-head-commit`): GitHub refuses the merge if the branch head
	 * moved after CI passed, so nothing unverified can ride in.
	 */
	async squashMerge(prNumber: number, headSha: string): Promise<{ merged: true; mergeSha: string } | { merged: false; reason: string }> {
		if (!Number.isSafeInteger(prNumber) || prNumber < 1 || !GIT_SHA.test(headSha)) throw new Error("Squash merge requires a PR number and its exact head SHA.");
		const response = await fetch(`https://api.github.com/repos/${this.config.repository}/pulls/${prNumber}/merge`, bounded({
			method: "PUT",
			headers: githubHeaders(await this.installationToken()),
			body: JSON.stringify({ merge_method: "squash", sha: headSha }),
		}));
		if (response.status === 409) return { merged: false, reason: "head-sha-moved" };
		if (response.status === 405) return { merged: false, reason: "not-mergeable" };
		if (!response.ok) return { merged: false, reason: `merge-rejected-${response.status}` };
		const body = await response.json() as { merged?: unknown; sha?: unknown };
		if (body.merged !== true || typeof body.sha !== "string" || !GIT_SHA.test(body.sha)) return { merged: false, reason: "merge-response-invalid" };
		return { merged: true, mergeSha: body.sha };
	}

	/**
	 * Read whether a PR is ALREADY merged, and from which head into which merge
	 * commit. Recovery read for the crash window between a successful squash
	 * merge and its ledger transaction: re-merging an already-merged PR gets a
	 * 405 from GitHub, which must not be misread as a refusal of the change.
	 */
	async pullRequestMergeState(prNumber: number): Promise<{ merged: boolean; mergeSha: string | null; headSha: string | null }> {
		if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error("PR merge-state observation requires a PR number.");
		const response = await fetch(`https://api.github.com/repos/${this.config.repository}/pulls/${prNumber}`, bounded({ headers: githubHeaders(await this.installationToken()) }));
		if (!response.ok) throw new Error(`GitHub PR merge-state observation failed (${response.status}).`);
		const body = await response.json() as { merged?: unknown; merge_commit_sha?: unknown; head?: { sha?: unknown } };
		return {
			merged: body.merged === true,
			mergeSha: typeof body.merge_commit_sha === "string" && GIT_SHA.test(body.merge_commit_sha) ? body.merge_commit_sha : null,
			headSha: typeof body.head?.sha === "string" && GIT_SHA.test(body.head.sha) ? body.head.sha : null,
		};
	}

	/** Dispatch a workflow on main. Used for the product deploy and the revert redeploy. */
	async dispatchWorkflow(workflowFile: string, inputs: Record<string, string>): Promise<void> {
		if (!/^[A-Za-z0-9._-]+\.ya?ml$/u.test(workflowFile)) throw new Error("Workflow dispatch requires a workflow file name.");
		const response = await fetch(`https://api.github.com/repos/${this.config.repository}/actions/workflows/${workflowFile}/dispatches`, bounded({
			method: "POST",
			headers: githubHeaders(await this.installationToken()),
			body: JSON.stringify({ ref: "main", inputs }),
		}));
		if (!response.ok) throw new Error(`GitHub workflow dispatch failed (${response.status}).`);
	}
}

/**
 * Observe the deployed product's /version endpoint. "Live" is only ever this
 * observation: the endpoint actually serving the expected revision. Returns
 * the SHA it reports, or null when unreachable/invalid.
 */
export async function observeDeployedVersion(productUrl: string): Promise<string | null> {
	try {
		const url = new URL("/version", productUrl);
		if (url.protocol !== "https:") return null;
		const response = await fetch(url.toString(), { headers: { "user-agent": "app-harness-platform-observer" }, signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) });
		if (!response.ok) return null;
		const body = await response.json() as { sha?: unknown };
		return typeof body.sha === "string" && GIT_SHA.test(body.sha) ? body.sha : null;
	} catch {
		return null;
	}
}

/** The liveness watchdog's synthetic fetch: does the product render at all? */
export async function syntheticLivenessCheck(productUrl: string): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		const response = await fetch(productUrl, { headers: { "user-agent": "app-harness-platform-watchdog" }, redirect: "follow", signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) });
		if (!response.ok) return { ok: false, reason: `status-${response.status}` };
		const text = await response.text();
		if (!text.toLowerCase().includes("<body")) return { ok: false, reason: "no-document-body" };
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: error instanceof Error && error.name === "TimeoutError" ? "fetch-timeout" : "fetch-failed" };
	}
}
