type Env = {
	ALLOWED_REPOSITORY: string;
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

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const GIT_PATH = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

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
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) return null;
	const [payloadPart, signaturePart, extra] = header.slice(7).split(".");
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

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		if (request.method !== "GET" && request.method !== "POST") return new Response("Not found", { status: 404 });
		const assertion = await validateAssertion(request, env);
		if (!assertion) return new Response("Not found", { status: 404 });
		const url = new URL(request.url);
		const match = GIT_PATH.exec(url.pathname);
		if (!match || `${match[1]}/${match[2]}`.toLowerCase() !== env.ALLOWED_REPOSITORY.toLowerCase()) {
			return new Response("Not found", { status: 404 });
		}

		try {
			const headers = new Headers(request.headers);
			headers.delete("authorization");
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
