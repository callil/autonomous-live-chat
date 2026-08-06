type Env = {
	ALLOWED_REPOSITORY: string;
	PRODUCTION_ORIGIN: string;
	GIT_PROXY_ASSERTION_SECRET: string;
	GITHUB_APP_ID: string;
	GITHUB_APP_INSTALLATION_ID: string;
	GITHUB_APP_PRIVATE_KEY: string;
};

type Assertion = {
	iss: "app-harness-os-native-git";
	jobId: string;
	repository: string;
	generation: number;
	exp: number;
};

type Classification = "triage" | "agent" | "needs-review" | "rejected" | "deployed";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GIT_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const ISSUE_PATH = /^\/v1\/issues\/(\d+)$/;
const ISSUE_LABELS_PATH = /^\/v1\/issues\/(\d+)\/classification$/;
const ISSUE_STATUS_PATH = /^\/v1\/issues\/(\d+)\/status$/;
const ISSUE_CLOSE_PATH = /^\/v1\/issues\/(\d+)\/close-after-deployment$/;
const EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SAFE_ISSUE_TITLE = /^[\p{L}\p{N}\p{P}\p{Z}\n\r\t]+$/u;
const CLASSIFICATION_LABELS: Readonly<Record<Classification, readonly string[]>> = {
	triage: ["app-harness", "triage"],
	agent: ["app-harness", "agent"],
	"needs-review": ["app-harness", "needs-review"],
	rejected: ["app-harness", "rejected"],
	deployed: ["app-harness", "deployed"],
};
const MANAGED_CLASSIFICATION_LABELS = new Set(Object.values(CLASSIFICATION_LABELS).flat());

function base64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
	try {
		const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
		const binary = atob(padded);
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) return false;
	let result = 0;
	for (let index = 0; index < left.length; index += 1) result |= left[index] ^ right[index];
	return result === 0;
}

async function validateAssertion(request: Request, env: Env): Promise<Assertion | null> {
	const header = request.headers.get("x-app-harness-assertion");
	if (!header) return null;
	const [payloadPart, signaturePart, extra] = header.split(".");
	if (!payloadPart || !signaturePart || extra) return null;
	const payloadBytes = decodeBase64Url(payloadPart);
	const signature = decodeBase64Url(signaturePart);
	if (!payloadBytes || !signature || !equal(signature, await hmac(env.GIT_PROXY_ASSERTION_SECRET, payloadPart))) return null;
	try {
		const payload = JSON.parse(decoder.decode(payloadBytes)) as Assertion;
		if (payload.iss !== "app-harness-os-native-git" || payload.repository !== env.ALLOWED_REPOSITORY) return null;
		if (!Number.isInteger(payload.generation) || !Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
		if (typeof payload.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/u.test(payload.jobId)) return null;
		return payload;
	} catch {
		return null;
	}
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

async function installationToken(env: Env): Promise<string> {
	const response = await fetch(`https://api.github.com/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`, {
		method: "POST",
		headers: {
			accept: "application/vnd.github+json",
			authorization: `Bearer ${await appJwt(env)}`,
			"user-agent": "app-harness-os-git-proxy",
			"x-github-api-version": "2022-11-28",
		},
	});
	if (!response.ok) throw new Error(`GitHub App installation token request failed (${response.status}).`);
	const body = await response.json() as { token?: unknown };
	if (typeof body.token !== "string" || !body.token) throw new Error("GitHub App returned no installation token.");
	return body.token;
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function validIssueNumber(value: string | undefined): number | null {
	if (!value || !/^[1-9]\d{0,8}$/u.test(value)) return null;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : null;
}

function readText(value: unknown, maximum: number): string | null {
	if (typeof value !== "string" || !value || value.length > maximum || !SAFE_ISSUE_TITLE.test(value)) return null;
	return value;
}

function readEventId(value: unknown): string | null {
	return typeof value === "string" && EVENT_ID.test(value) ? value : null;
}

function readClassification(value: unknown): Classification | null {
	return typeof value === "string" && Object.hasOwn(CLASSIFICATION_LABELS, value) ? value as Classification : null;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
	try {
		const value = await request.json();
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
	} catch {
		return null;
	}
}

function githubHeaders(token: string): HeadersInit {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"content-type": "application/json",
		"user-agent": "app-harness-os-git-proxy",
		"x-github-api-version": "2022-11-28",
	};
}

function eventMarker(eventId: string): string {
	return `<!-- app-harness-event:${eventId} -->`;
}

async function upsertStatusComment(env: Env, token: string, issueNumber: number, eventId: string, body: string): Promise<Response> {
	const marker = eventMarker(eventId);
	const text = `${body}\n\n${marker}`;
	const comments = await fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}/issues/${issueNumber}/comments?per_page=100`, { headers: githubHeaders(token) });
	if (!comments.ok) return comments;
	const existing = await comments.json() as Array<{ id?: unknown; body?: unknown }>;
	const matched = existing.find((comment) => typeof comment.id === "number" && typeof comment.body === "string" && comment.body.includes(marker));
	if (matched && typeof matched.id === "number") {
		return fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}/issues/comments/${matched.id}`, { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ body: text }) });
	}
	return fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}/issues/${issueNumber}/comments`, { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ body: text }) });
}

async function reconcileClassification(env: Env, token: string, issueNumber: number, classification: Classification): Promise<Response> {
	const current = await fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}/issues/${issueNumber}`, { headers: githubHeaders(token) });
	if (!current.ok) return current;
	const issue = await current.json() as { labels?: Array<{ name?: unknown }> };
	const labels = (issue.labels ?? []).flatMap((label) => typeof label.name === "string" ? [label.name] : []).filter((label) => !MANAGED_CLASSIFICATION_LABELS.has(label));
	labels.push(...CLASSIFICATION_LABELS[classification]);
	return fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}/issues/${issueNumber}`, { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ labels }) });
}

function productionUrl(env: Env, value: unknown): string | null {
	if (typeof value !== "string" || value.length > 1024) return null;
	try {
		const candidate = new URL(value);
		const origin = new URL(env.PRODUCTION_ORIGIN);
		return candidate.protocol === "https:" && candidate.origin === origin.origin ? candidate.toString() : null;
	} catch {
		return null;
	}
}

async function handleIssueBridge(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (request.method !== "POST") return null;
	const create = url.pathname === "/v1/issues";
	const issuePath = ISSUE_PATH.exec(url.pathname);
	const labelPath = ISSUE_LABELS_PATH.exec(url.pathname);
	const statusPath = ISSUE_STATUS_PATH.exec(url.pathname);
	const closePath = ISSUE_CLOSE_PATH.exec(url.pathname);
	if (!create && !issuePath && !labelPath && !statusPath && !closePath) return null;
	const input = await readJson(request);
	if (!input) return new Response("Not found", { status: 404 });
	const eventId = readEventId(input.eventId);
	if (!eventId) return new Response("Not found", { status: 404 });
	if (create) {
		const title = readText(input.title, 140);
		const body = readText(input.body, 8_000);
		const classification = readClassification(input.classification);
		if (!title || !body || !classification) return new Response("Not found", { status: 404 });
		const token = await installationToken(env);
		const result = await fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}/issues`, { method: "POST", headers: githubHeaders(token), body: JSON.stringify({ title, body: `${body}\n\n${eventMarker(eventId)}`, labels: CLASSIFICATION_LABELS[classification] }) });
		if (!result.ok) return new Response("GitHub write unavailable", { status: 503 });
		const issue = await result.json() as { number?: unknown; html_url?: unknown };
		return typeof issue.number === "number" && typeof issue.html_url === "string" ? json({ issueNumber: issue.number, issueUrl: issue.html_url }) : new Response("GitHub write unavailable", { status: 503 });
	}
	const issueNumber = validIssueNumber((issuePath ?? labelPath ?? statusPath ?? closePath)?.[1]);
	if (!issueNumber) return new Response("Not found", { status: 404 });
	if (labelPath) {
		const classification = readClassification(input.classification);
		if (!classification) return new Response("Not found", { status: 404 });
		const token = await installationToken(env);
		const result = await reconcileClassification(env, token, issueNumber, classification);
		return result.ok ? json({ issueNumber, classification }) : new Response("GitHub write unavailable", { status: 503 });
	}
	if (statusPath) {
		const body = readText(input.body, 6_000);
		if (!body) return new Response("Not found", { status: 404 });
		const token = await installationToken(env);
		const result = await upsertStatusComment(env, token, issueNumber, eventId, body);
		return result.ok ? json({ issueNumber, eventId }) : new Response("GitHub write unavailable", { status: 503 });
	}
	if (closePath) {
		const deploymentUrl = productionUrl(env, input.deploymentUrl);
		const body = readText(input.body, 4_000);
		if (!deploymentUrl || !body) return new Response("Not found", { status: 404 });
		const live = await fetch(deploymentUrl, { method: "GET", redirect: "follow", headers: { "user-agent": "app-harness-os-git-proxy-verifier" } });
		if (!live.ok) return new Response("Deployment verification unavailable", { status: 503 });
		const token = await installationToken(env);
		const comment = await upsertStatusComment(env, token, issueNumber, eventId, `${body}\n\nVerified reachable deployment: ${deploymentUrl}`);
		if (!comment.ok) return new Response("GitHub write unavailable", { status: 503 });
		const close = await fetch(`https://api.github.com/repos/${env.ALLOWED_REPOSITORY}/issues/${issueNumber}`, { method: "PATCH", headers: githubHeaders(token), body: JSON.stringify({ state: "closed" }) });
		return close.ok ? json({ issueNumber, state: "closed", deploymentUrl }) : new Response("GitHub write unavailable", { status: 503 });
	}
	return new Response("Not found", { status: 404 });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "GET" && request.method !== "POST") return new Response("Not found", { status: 404 });
		const assertion = await validateAssertion(request, env);
		if (!assertion) return new Response("Not found", { status: 404 });
		const url = new URL(request.url);
		try {
			const issueResponse = await handleIssueBridge(request, env, url);
			if (issueResponse) return issueResponse;
		} catch (error) {
			console.error("GitHub App identity bridge failure", { jobId: assertion.jobId, generation: assertion.generation, error: error instanceof Error ? error.message : "unknown" });
			return new Response("GitHub write unavailable", { status: 503 });
		}
		const match = GIT_PATH.exec(url.pathname);
		if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== env.ALLOWED_REPOSITORY.toLowerCase()) {
			return new Response("Not found", { status: 404 });
		}

		try {
			const headers = new Headers(request.headers);
			headers.delete("authorization");
			headers.delete("x-app-harness-assertion");
			headers.delete("host");
			headers.set("authorization", `Basic ${btoa(`x-access-token:${await installationToken(env)}`)}`);
			headers.set("user-agent", "app-harness-os-git-proxy");
			const upstream = await fetch(`https://github.com${url.pathname}${url.search}`, {
				method: request.method,
				headers,
				body: request.method === "POST" ? request.body : undefined,
			});
			const responseHeaders = new Headers(upstream.headers);
			responseHeaders.delete("set-cookie");
			return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
		} catch (error) {
			console.error("git credential proxy failure", { jobId: assertion.jobId, generation: assertion.generation, error: error instanceof Error ? error.message : "unknown" });
			return new Response("Credential bridge unavailable", { status: 503 });
		}
	},
};
