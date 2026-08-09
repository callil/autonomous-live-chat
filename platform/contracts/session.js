/**
 * Lightweight-but-real identity (phase 3, v1 non-negotiable): the platform
 * issues signed session tokens carrying a display-name claim plus a stable
 * random id. The signing key is DERIVED from the ADMIN_TOKEN worker secret
 * (HMAC-SHA-256 over a fixed domain-separation label), so no new secret has
 * to be provisioned; rotating ADMIN_TOKEN rotates every session.
 *
 * The token is `base64url(payload).base64url(hmac)`. The stable id — not the
 * display name — is the attribution and rate-limit key. No OAuth in v1.
 */

const encoder = new TextEncoder();

/** Display names stay bounded and header/trailer safe (same shape the runner enforces). */
export const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;

/** Sessions outlive a conversation but not a leaked laptop: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;

const KEY_LABEL = "app-harness-platform-session-v1";

function base64UrlEncode(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(text) {
	if (typeof text !== "string" || !/^[A-Za-z0-9_-]+$/u.test(text)) return null;
	try {
		const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}

/** The session-signing key, derived from (never equal to) the admin token. */
async function sessionKey(adminToken) {
	if (typeof adminToken !== "string" || !adminToken.length) throw new Error("Session signing requires the ADMIN_TOKEN secret.");
	const material = await crypto.subtle.digest("SHA-256", encoder.encode(`${KEY_LABEL}:${adminToken}`));
	return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/**
 * Mint a signed session for a validated display name. The id is the stable
 * attribution key; the name is only ever presentation.
 */
export async function mintSessionToken(adminToken, name, now = Date.now()) {
	if (typeof name !== "string" || !SESSION_NAME.test(name)) throw new Error("Display names are 1-64 characters: letters, numbers, spaces, dot, underscore, dash.");
	const identity = { id: `user-${crypto.randomUUID()}`, name, iat: now };
	const payload = encoder.encode(JSON.stringify(identity));
	const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await sessionKey(adminToken), payload));
	return { token: `${base64UrlEncode(payload)}.${base64UrlEncode(signature)}`, identity };
}

/**
 * Verify a presented token: constant-time HMAC check (WebCrypto verify),
 * shape validation, and TTL. Returns the identity or null — never throws on
 * malformed input, because every byte here is attacker-controlled.
 */
export async function verifySessionToken(adminToken, token, now = Date.now()) {
	if (typeof adminToken !== "string" || !adminToken.length) return null;
	if (typeof token !== "string" || token.length > 2048) return null;
	const dot = token.indexOf(".");
	if (dot <= 0) return null;
	const payload = base64UrlDecode(token.slice(0, dot));
	const signature = base64UrlDecode(token.slice(dot + 1));
	if (!payload || !signature) return null;
	let verified = false;
	try {
		verified = await crypto.subtle.verify("HMAC", await sessionKey(adminToken), signature, payload);
	} catch {
		return null;
	}
	if (!verified) return null;
	let identity;
	try {
		identity = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return null;
	}
	if (!identity || typeof identity !== "object") return null;
	const { id, name, iat } = identity;
	if (typeof id !== "string" || !/^user-[0-9a-f-]{36}$/u.test(id)) return null;
	if (typeof name !== "string" || !SESSION_NAME.test(name)) return null;
	if (!Number.isSafeInteger(iat) || iat < 0 || now - iat > SESSION_TTL_MS || iat > now + 60_000) return null;
	return { id, name, iat };
}

/** Sliding-window rate limit: prune, check, and record one action for a key. */
export function admitRateLimited(windows, key, now, { limit, windowMs }) {
	const timestamps = (windows.get(key) ?? []).filter((at) => now - at < windowMs);
	if (timestamps.length >= limit) {
		windows.set(key, timestamps);
		return false;
	}
	timestamps.push(now);
	windows.set(key, timestamps);
	return true;
}
