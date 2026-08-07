/**
 * Private, repository-scoped GitHub App capability.
 *
 * This module deliberately has no HTTP automation API.  Only a Worker
 * Entrypoint can construct this capability, so the App private key never
 * leaves this Worker and callers use a private service binding/RPC instead
 * of a shared coordinator secret.
 */
export type GitHubBridgeEnv = {
	ALLOWED_REPOSITORY: string;
	PRODUCTION_ORIGIN: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_INSTALLATION_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
};

export type Classification = "triage" | "agent" | "needs-review" | "rejected" | "deployed";
export type ModelClassification = {
	changeType: "visual" | "content" | "data" | "behavior" | "infrastructure";
	scope: "localized" | "bounded" | "broad";
	risk: "low" | "medium" | "high";
	affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure";
	reversible: boolean;
	executionEligibility: "eligible" | "needs_review";
	ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure";
};

export type CreateIssueInput = {
	eventId: string;
	title: string;
	body: string;
	classification: Classification;
};

export type UpdateClassificationInput = {
	issueNumber: number;
	classification: Classification;
	modelClassification?: ModelClassification;
};

export type PostStatusInput = {
	issueNumber: number;
	eventId: string;
	body: string;
};

export type CloseAfterDeploymentInput = PostStatusInput & { deploymentUrl: string };

export type DispatchPromotionInput = {
	pullRequest: number;
	stackId: string;
	generation: number;
	issueNumber: number;
	parentBranch: string;
	headSha: string;
	/** Durable idempotency key used for exactly one workflow dispatch and observation. */
	dispatchKey: string;
	ciProfile: ModelClassification["ciProfile"];
};

export type CandidateObservationInput = {
	branch: string;
	pullRequestBase: string;
};

export type CandidateValidationObservationInput = {
	pullRequest: number;
	headSha: string;
};

export type PromotionRunObservationInput = {
	/** Durable idempotency key used for exactly one workflow dispatch and observation. */
	dispatchKey: string;
	createdAfter?: string;
};

const encoder = new TextEncoder();
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const SAFE_ISSUE_TEXT = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]+$/u;
const SIMPLE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const CLASSIFICATION_LABELS: Readonly<Record<Classification, readonly string[]>> = {
	triage: ["app-harness", "triage"],
	agent: ["app-harness", "agent"],
	"needs-review": ["app-harness", "needs-review"],
	rejected: ["app-harness", "rejected"],
	deployed: ["app-harness", "deployed"],
};
const CHANGE_TYPES = ["visual", "content", "data", "behavior", "infrastructure"] as const;
const SCOPES = ["localized", "bounded", "broad"] as const;
const RISKS = ["low", "medium", "high"] as const;
const SURFACES = ["ui", "copy", "data", "behavior", "infrastructure"] as const;
const EXECUTIONS = ["eligible", "needs_review"] as const;
const CI_PROFILES = ["visual", "content", "behavior", "data", "infrastructure"] as const;
const MANAGED_CLASSIFICATION_LABELS = new Set([
	...Object.values(CLASSIFICATION_LABELS).flat(),
	...CHANGE_TYPES.map((value) => `change-${value}`),
	...SCOPES.map((value) => `scope-${value}`),
	...RISKS.map((value) => `risk-${value}`),
	...SURFACES.map((value) => `surface-${value}`),
	"reversible-yes", "reversible-no",
	...EXECUTIONS.map((value) => `execution-${value}`),
	...CI_PROFILES.map((value) => `ci-${value}`),
]);

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

function validIssueNumber(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0 && value <= 999_999_999;
}

function validText(value: string): boolean {
	return Boolean(value) && SAFE_ISSUE_TEXT.test(value);
}

function validEventId(value: string): boolean {
	return EVENT_ID.test(value);
}

function validIdentifier(value: string): boolean {
	return SIMPLE_IDENTIFIER.test(value);
}

function safeBranchName(value: string): boolean {
	return !value.includes("..") && !value.startsWith("-") && !value.endsWith("/");
}

function validTimestamp(value: string): boolean {
	return Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/u.test(value);
}

function promotionRunName(dispatchKey: string): string {
	return `App Harness promotion · ${dispatchKey}`;
}

function candidateRunName(pullRequest: number, headSha: string): string {
	return `App Harness candidate · PR #${pullRequest} · ${headSha}`;
}

function enumValue<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function validModelClassification(value: ModelClassification): boolean {
	return enumValue(value.changeType, CHANGE_TYPES)
		&& enumValue(value.scope, SCOPES)
		&& enumValue(value.risk, RISKS)
		&& enumValue(value.affectedSurface, SURFACES)
		&& typeof value.reversible === "boolean"
		&& enumValue(value.executionEligibility, EXECUTIONS)
		&& enumValue(value.ciProfile, CI_PROFILES);
}

function modelClassificationLabels(classification: ModelClassification | undefined): string[] {
	if (!classification) return [];
	return [
		`change-${classification.changeType}`,
		`scope-${classification.scope}`,
		`risk-${classification.risk}`,
		`surface-${classification.affectedSurface}`,
		classification.reversible ? "reversible-yes" : "reversible-no",
		`execution-${classification.executionEligibility}`,
		`ci-${classification.ciProfile}`,
	];
}

function githubHeaders(token: string): HeadersInit {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": "app-harness-github-capability",
		"x-github-api-version": "2022-11-28",
	};
}

function eventMarker(eventId: string): string {
	return `<!-- app-harness-event:${eventId} -->`;
}

function durableReferenceBody(eventId: string): string {
	return `GitHub rejected the complete representation as unprocessable. The full text remains preserved in durable App Harness work item \`${eventId}\`.`;
}

async function withDurableReferenceFallback(eventId: string, body: string, write: (body: string) => Promise<Response>): Promise<Response> {
	const result = await write(body);
	return result.status === 422 ? write(durableReferenceBody(eventId)) : result;
}

function productionUrl(env: GitHubBridgeEnv, value: string): string {
	const candidate = new URL(value);
	const origin = new URL(env.PRODUCTION_ORIGIN);
	if (candidate.protocol !== "https:" || candidate.origin !== origin.origin) throw new Error("Deployment URL is outside the configured production origin.");
	return candidate.toString();
}

/** A small private capability, suitable for a named service binding. */
export class GitHubCapability {
	private readonly env: GitHubBridgeEnv;

	constructor(env: GitHubBridgeEnv) {
		this.env = env;
	}

	private async appJwt(): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		const header = base64Url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
		const payload = base64Url(encoder.encode(JSON.stringify({ iat: now - 30, exp: now + 540, iss: this.env.GITHUB_APP_ID })));
		const key = await crypto.subtle.importKey("pkcs8", pemToDer(this.env.GITHUB_APP_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
		const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${payload}`)));
		return `${header}.${payload}.${base64Url(signature)}`;
	}

	async createRunnerToken(input: { repository: string; jobId: string; generation: number }): Promise<{ token: string; expiresAt: string }> {
		if (input.repository !== this.env.ALLOWED_REPOSITORY || !validEventId(input.jobId) || !Number.isSafeInteger(input.generation) || input.generation < 1) {
			throw new Error("Runner capability is outside the installed repository scope.");
		}
		const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(this.env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`, {
			method: "POST",
			headers: {
				accept: "application/vnd.github+json",
				authorization: `Bearer ${await this.appJwt()}`,
				"user-agent": "app-harness-github-capability",
				"x-github-api-version": "2022-11-28",
			},
		});
		if (!response.ok) throw new Error(`GitHub App installation token request failed (${response.status}).`);
		const body = await response.json() as { token?: unknown; expires_at?: unknown };
		if (typeof body.token !== "string" || !body.token || typeof body.expires_at !== "string") throw new Error("GitHub App returned no installation capability.");
		return { token: body.token, expiresAt: body.expires_at };
	}

	private async installationToken(): Promise<string> {
		return (await this.createRunnerToken({ repository: this.env.ALLOWED_REPOSITORY, jobId: "github-api", generation: 1 })).token;
	}

	private async findIssueByMarker(token: string, eventId: string): Promise<{ number: number; htmlUrl: string } | null> {
		const marker = eventMarker(eventId);
		// Repository issue listing is read-after-write and therefore safe for an
		// immediate retry. GitHub's search index is asynchronous and previously
		// allowed several issues with the same durable marker to be created within
		// seconds of one another.
		const listed = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues?state=all&sort=created&direction=desc&per_page=100`, { headers: githubHeaders(token) });
		if (!listed.ok) throw new Error(`GitHub issue listing failed (${listed.status}).`);
		const recent = await listed.json() as Array<{ number?: unknown; html_url?: unknown; body?: unknown; pull_request?: unknown }>;
		const direct = recent.find((issue) => issue.pull_request === undefined && typeof issue.body === "string" && issue.body.includes(marker));
		if (typeof direct?.number === "number" && typeof direct.html_url === "string") return { number: direct.number, htmlUrl: direct.html_url };

		// Search remains a bounded fallback for older issues outside the recent
		// page, never the correctness mechanism for a just-created side effect.
		const query = new URLSearchParams({ q: `repo:${this.env.ALLOWED_REPOSITORY} is:issue in:body "${eventMarker(eventId)}"`, per_page: "2" });
		const response = await fetch(`https://api.github.com/search/issues?${query}`, { headers: githubHeaders(token) });
		if (!response.ok) throw new Error(`GitHub issue search failed (${response.status}).`);
		const body = await response.json() as { items?: Array<{ number?: unknown; html_url?: unknown }> };
		const issue = body.items?.[0];
		return typeof issue?.number === "number" && typeof issue.html_url === "string" ? { number: issue.number, htmlUrl: issue.html_url } : null;
	}

	private async upsertStatusComment(token: string, issueNumber: number, eventId: string, body: string): Promise<Response> {
		const marker = eventMarker(eventId);
		const text = `${body}\n\n${marker}`;
		const comments = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues/${issueNumber}/comments?per_page=100`, { headers: githubHeaders(token) });
		if (!comments.ok) return comments;
		const existing = await comments.json() as Array<{ id?: unknown; body?: unknown }>;
		const matched = existing.find((comment) => typeof comment.id === "number" && typeof comment.body === "string" && comment.body.includes(marker));
		if (matched && typeof matched.id === "number") {
			return fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues/comments/${matched.id}`, { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ body: text }) });
		}
		return fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues/${issueNumber}/comments`, { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ body: text }) });
	}

	private async reconcileClassification(token: string, issueNumber: number, classification: Classification, modelClassification?: ModelClassification): Promise<Response> {
		const current = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues/${issueNumber}`, { headers: githubHeaders(token) });
		if (!current.ok) return current;
		const issue = await current.json() as { labels?: Array<{ name?: unknown }> };
		const labels = (issue.labels ?? []).flatMap((label) => typeof label.name === "string" ? [label.name] : []).filter((label) => !MANAGED_CLASSIFICATION_LABELS.has(label));
		labels.push(...CLASSIFICATION_LABELS[classification], ...modelClassificationLabels(modelClassification));
		return fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues/${issueNumber}`, { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ labels }) });
	}

	async createIssue(input: CreateIssueInput): Promise<{ issueNumber: number; issueUrl: string; existing?: true }> {
		if (!validEventId(input.eventId) || !validText(input.title) || !validText(input.body) || !Object.hasOwn(CLASSIFICATION_LABELS, input.classification)) throw new Error("Invalid issue projection input.");
		const token = await this.installationToken();
		const existing = await this.findIssueByMarker(token, input.eventId);
		if (existing) return { issueNumber: existing.number, issueUrl: existing.htmlUrl, existing: true };
		const result = await withDurableReferenceFallback(input.eventId, input.body, (representation) =>
			fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues`, { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ title: input.title, body: `${representation}\n\n${eventMarker(input.eventId)}`, labels: CLASSIFICATION_LABELS[input.classification] }) }),
		);
		if (!result.ok) throw new Error(`GitHub issue creation failed (${result.status}).`);
		const issue = await result.json() as { number?: unknown; html_url?: unknown };
		if (typeof issue.number !== "number" || typeof issue.html_url !== "string") throw new Error("GitHub issue creation returned no issue.");
		return { issueNumber: issue.number, issueUrl: issue.html_url };
	}

	async updateClassification(input: UpdateClassificationInput): Promise<{ issueNumber: number; classification: Classification }> {
		if (!validIssueNumber(input.issueNumber) || !Object.hasOwn(CLASSIFICATION_LABELS, input.classification) || (input.modelClassification && !validModelClassification(input.modelClassification))) throw new Error("Invalid classification projection input.");
		const result = await this.reconcileClassification(await this.installationToken(), input.issueNumber, input.classification, input.modelClassification);
		if (!result.ok) throw new Error(`GitHub classification update failed (${result.status}).`);
		return { issueNumber: input.issueNumber, classification: input.classification };
	}

	async postStatus(input: PostStatusInput): Promise<{ issueNumber: number; eventId: string }> {
		if (!validIssueNumber(input.issueNumber) || !validEventId(input.eventId) || !validText(input.body)) throw new Error("Invalid issue status input.");
		const result = await withDurableReferenceFallback(input.eventId, input.body, async (representation) => this.upsertStatusComment(await this.installationToken(), input.issueNumber, input.eventId, representation));
		if (!result.ok) throw new Error(`GitHub status update failed (${result.status}).`);
		return { issueNumber: input.issueNumber, eventId: input.eventId };
	}

	async closeAfterDeployment(input: CloseAfterDeploymentInput): Promise<{ issueNumber: number; state: "closed"; deploymentUrl: string }> {
		if (!validIssueNumber(input.issueNumber) || !validEventId(input.eventId) || !validText(input.body)) throw new Error("Invalid deployment completion input.");
		const deploymentUrl = productionUrl(this.env, input.deploymentUrl);
		const live = await fetch(deploymentUrl, { method: "GET", redirect: "follow", headers: { "user-agent": "app-harness-github-capability-verifier" } });
		if (!live.ok) throw new Error(`Deployment verification failed (${live.status}).`);
		await live.body?.cancel();
		const token = await this.installationToken();
		const labels = await this.reconcileClassification(token, input.issueNumber, "deployed");
		if (!labels.ok) throw new Error(`GitHub completion label update failed (${labels.status}).`);
		const comment = await withDurableReferenceFallback(input.eventId, `${input.body}\n\nVerified reachable deployment: ${deploymentUrl}`, (representation) => this.upsertStatusComment(token, input.issueNumber, input.eventId, representation));
		if (!comment.ok) throw new Error(`GitHub completion comment failed (${comment.status}).`);
		const close = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/issues/${input.issueNumber}`, { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ state: "closed" }) });
		if (!close.ok) throw new Error(`GitHub issue close failed (${close.status}).`);
		return { issueNumber: input.issueNumber, state: "closed", deploymentUrl };
	}

	async getMainSha(): Promise<{ sha: string }> {
		const response = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/git/ref/heads/main`, { headers: githubHeaders(await this.installationToken()) });
		if (!response.ok) throw new Error(`GitHub main reference read failed (${response.status}).`);
		const body = await response.json() as { object?: { sha?: unknown } };
		if (typeof body.object?.sha !== "string" || !GIT_SHA.test(body.object.sha)) throw new Error("GitHub main reference returned no immutable SHA.");
		return { sha: body.object.sha };
	}

	async getCandidate(input: CandidateObservationInput): Promise<{ number: number; url: string; headSha: string; base: string; state: string } | null> {
		if (!validIdentifier(input.branch) || !validIdentifier(input.pullRequestBase) || !safeBranchName(input.branch) || !safeBranchName(input.pullRequestBase)) throw new Error("Invalid candidate observation input.");
		const owner = this.env.ALLOWED_REPOSITORY.split("/")[0];
		const query = new URLSearchParams({ state: "all", head: `${owner}:${input.branch}`, base: input.pullRequestBase, per_page: "100" });
		const response = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/pulls?${query}`, { headers: githubHeaders(await this.installationToken()) });
		if (!response.ok) throw new Error(`GitHub candidate observation failed (${response.status}).`);
		const pulls = await response.json() as Array<{ number?: unknown; html_url?: unknown; state?: unknown; head?: { ref?: unknown; sha?: unknown }; base?: { ref?: unknown } }>;
		const candidate = pulls.find((pull) => pull.head?.ref === input.branch && pull.base?.ref === input.pullRequestBase);
		if (!candidate) return null;
		if (!validIssueNumber(candidate.number as number) || typeof candidate.html_url !== "string" || typeof candidate.state !== "string" || typeof candidate.head?.sha !== "string" || !GIT_SHA.test(candidate.head.sha)) throw new Error("GitHub candidate observation returned an invalid response.");
		return { number: candidate.number as number, url: candidate.html_url, headSha: candidate.head.sha, base: input.pullRequestBase, state: candidate.state };
	}

	async dispatchPromotion(input: DispatchPromotionInput): Promise<{ dispatchKey: string; dispatched: true }> {
		if (!validIssueNumber(input.pullRequest) || !validIssueNumber(input.issueNumber) || !validIdentifier(input.stackId) || !validIdentifier(input.dispatchKey) || !validIdentifier(input.parentBranch) || !GIT_SHA.test(input.headSha) || !Number.isSafeInteger(input.generation) || input.generation < 1 || !enumValue(input.ciProfile, CI_PROFILES)) {
			throw new Error("Invalid promotion dispatch input.");
		}
		const response = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/actions/workflows/os-stack-promote.yml/dispatches`, {
			method: "POST",
			headers: githubHeaders(await this.installationToken()),
			body: JSON.stringify({ ref: "main", inputs: {
				pull_request: String(input.pullRequest), stack_id: input.stackId, generation: String(input.generation), issue_number: String(input.issueNumber), parent_branch: input.parentBranch, head_sha: input.headSha, dispatch_key: input.dispatchKey, ci_profile: input.ciProfile,
			} }),
		});
		if (!response.ok) throw new Error(`GitHub promotion dispatch failed (${response.status}).`);
		return { dispatchKey: input.dispatchKey, dispatched: true };
	}

	async observeCandidateValidation(input: CandidateValidationObservationInput): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null> {
		if (!validIssueNumber(input.pullRequest) || !GIT_SHA.test(input.headSha)) throw new Error("Invalid candidate validation observation input.");
		const query = new URLSearchParams({ event: "pull_request_target", per_page: "100" });
		const response = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/actions/workflows/os-stack-ci.yml/runs?${query}`, { headers: githubHeaders(await this.installationToken()) });
		if (!response.ok) throw new Error(`GitHub candidate validation observation failed (${response.status}).`);
		const body = await response.json() as { workflow_runs?: Array<{ id?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; display_title?: unknown; created_at?: unknown; event?: unknown; path?: unknown }> };
		const expectedTitle = candidateRunName(input.pullRequest, input.headSha);
		const run = body.workflow_runs?.find((candidate) => candidate.display_title === expectedTitle && candidate.event === "pull_request_target" && typeof candidate.path === "string" && candidate.path.startsWith(".github/workflows/os-stack-ci.yml"));
		if (!run) return null;
		if (!Number.isSafeInteger(run.id) || (run.id as number) < 1 || typeof run.status !== "string" || (run.conclusion !== null && typeof run.conclusion !== "string") || typeof run.html_url !== "string" || typeof run.created_at !== "string") throw new Error("GitHub candidate validation observation returned an invalid response.");
		return { runId: run.id as number, status: run.status, conclusion: run.conclusion, url: run.html_url, createdAt: run.created_at };
	}

	async observeWorkflowRun(input: { runId: number }): Promise<{ runId: number; status: string; conclusion: string | null; url: string }> {
		if (!Number.isSafeInteger(input.runId) || input.runId < 1) throw new Error("Invalid workflow run identifier.");
		const response = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/actions/runs/${input.runId}`, { headers: githubHeaders(await this.installationToken()) });
		if (!response.ok) throw new Error(`GitHub workflow observation failed (${response.status}).`);
		const body = await response.json() as { status?: unknown; conclusion?: unknown; html_url?: unknown };
		if (typeof body.status !== "string" || (body.conclusion !== null && typeof body.conclusion !== "string") || typeof body.html_url !== "string") throw new Error("GitHub workflow observation returned an invalid response.");
		return { runId: input.runId, status: body.status, conclusion: body.conclusion, url: body.html_url };
	}

	async findPromotionRun(input: PromotionRunObservationInput): Promise<{ runId: number; status: string; conclusion: string | null; url: string; createdAt: string } | null> {
		if (!validIdentifier(input.dispatchKey) || (input.createdAfter !== undefined && !validTimestamp(input.createdAfter))) throw new Error("Invalid promotion observation input.");
		const query = new URLSearchParams({ event: "workflow_dispatch", per_page: "100" });
		const response = await fetch(`https://api.github.com/repos/${this.env.ALLOWED_REPOSITORY}/actions/workflows/os-stack-promote.yml/runs?${query}`, { headers: githubHeaders(await this.installationToken()) });
		if (!response.ok) throw new Error(`GitHub promotion observation failed (${response.status}).`);
		const body = await response.json() as { workflow_runs?: Array<{ id?: unknown; status?: unknown; conclusion?: unknown; html_url?: unknown; display_title?: unknown; created_at?: unknown }> };
		const minimum = input.createdAfter ? Date.parse(input.createdAfter) : Number.NEGATIVE_INFINITY;
		const run = body.workflow_runs?.find((candidate) => candidate.display_title === promotionRunName(input.dispatchKey) && typeof candidate.created_at === "string" && Date.parse(candidate.created_at) >= minimum);
		if (!run) return null;
		if (!Number.isSafeInteger(run.id) || (run.id as number) < 1 || typeof run.status !== "string" || (run.conclusion !== null && typeof run.conclusion !== "string") || typeof run.html_url !== "string" || typeof run.created_at !== "string") throw new Error("GitHub promotion observation returned an invalid response.");
		return { runId: run.id as number, status: run.status, conclusion: run.conclusion, url: run.html_url, createdAt: run.created_at };
	}
}
