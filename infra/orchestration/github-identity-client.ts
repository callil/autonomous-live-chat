type GithubIdentityEnv = {
	GITHUB_IDENTITY_BRIDGE?: Fetcher;
	APP_HARNESS_IDENTITY_SECRET?: string;
};

export type GithubLifecycleClassification = "triage" | "agent" | "needs-review" | "rejected" | "deployed";

export type GithubModelClassification = {
	changeType: "visual" | "content" | "data" | "behavior" | "infrastructure";
	scope: "localized" | "bounded" | "broad";
	risk: "low" | "medium" | "high";
	affectedSurface: "ui" | "copy" | "data" | "behavior" | "infrastructure";
	reversible: boolean;
	executionEligibility: "eligible" | "needs_review";
	ciProfile: "visual" | "content" | "behavior" | "data" | "infrastructure";
};

type GithubIdentityContext = {
	workItemId: string;
};

type GithubIssue = {
	issueNumber: number;
	issueUrl: string;
};

const ALLOWED_REPOSITORY = "callil/autonomous-live-chat";
const WORK_ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function assertion(secret: string, context: GithubIdentityContext): Promise<string> {
	if (!WORK_ITEM_ID.test(context.workItemId)) {
		throw new Error("Invalid GitHub identity context.");
	}
	const payload = base64Url(encoder.encode(JSON.stringify({
		iss: "app-harness-coordinator",
		workItemId: context.workItemId,
		repository: ALLOWED_REPOSITORY,
		exp: Math.floor(Date.now() / 1000) + 300,
	})));
	return `${payload}.${base64Url(await hmac(secret, payload))}`;
}

async function request<T>(
	env: GithubIdentityEnv,
	context: GithubIdentityContext,
	path: string,
	body: Record<string, unknown>,
): Promise<T> {
	if (!env.GITHUB_IDENTITY_BRIDGE || !env.APP_HARNESS_IDENTITY_SECRET) {
		throw new Error("GitHub App identity bridge is unavailable.");
	}
	const response = await env.GITHUB_IDENTITY_BRIDGE.fetch(new Request(`https://github-identity.internal${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-app-harness-coordinator-assertion": await assertion(env.APP_HARNESS_IDENTITY_SECRET, context),
		},
		body: JSON.stringify(body),
	}));
	if (!response.ok) {
		const detail = (await response.text()).trim().slice(0, 240);
		throw new Error(`GitHub App identity bridge rejected the operation (${response.status}${detail ? `: ${detail}` : ""}).`);
	}
	return response.json<T>();
}

function eventId(context: GithubIdentityContext): string {
	return `work-${context.workItemId}`;
}

export function createGithubIdentityClient(env: GithubIdentityEnv, context: GithubIdentityContext) {
	const stableEventId = eventId(context);
	return {
		createIssue(input: { title: string; body: string; classification: GithubLifecycleClassification }): Promise<GithubIssue> {
			return request(env, context, "/v1/issues", { eventId: stableEventId, ...input });
		},
		reconcileClassification(input: { issueNumber: number; classification: GithubLifecycleClassification; modelClassification?: GithubModelClassification }): Promise<{ issueNumber: number }> {
			return request(env, context, `/v1/issues/${input.issueNumber}/classification`, { eventId: stableEventId, classification: input.classification, modelClassification: input.modelClassification });
		},
		updateStatus(input: { issueNumber: number; body: string }): Promise<{ issueNumber: number; eventId: string }> {
			return request(env, context, `/v1/issues/${input.issueNumber}/status`, { eventId: stableEventId, body: input.body });
		},
		closeAfterDeployment(input: { issueNumber: number; body: string; deploymentUrl: string }): Promise<{ issueNumber: number; state: "closed"; deploymentUrl: string }> {
			return request(env, context, `/v1/issues/${input.issueNumber}/close-after-deployment`, { eventId: stableEventId, body: input.body, deploymentUrl: input.deploymentUrl });
		},
	};
}
