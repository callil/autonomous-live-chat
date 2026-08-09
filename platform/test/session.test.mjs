import assert from "node:assert/strict";
import test from "node:test";
import { admitRateLimited, mintSessionToken, verifySessionToken, SESSION_TTL_MS } from "../contracts/session.js";

const SECRET = "admin-secret-for-tests";

test("a minted session verifies and carries a stable id distinct from the display name", async () => {
	const { token, identity } = await mintSessionToken(SECRET, "Ada L.", 1_000);
	assert.match(identity.id, /^user-[0-9a-f-]{36}$/u);
	assert.equal(identity.name, "Ada L.");
	const verified = await verifySessionToken(SECRET, token, 2_000);
	assert.deepEqual(verified, identity);
});

test("verification is a real signature check, not a parse", async () => {
	const { token } = await mintSessionToken(SECRET, "Ada", 1_000);
	assert.equal(await verifySessionToken("other-secret", token, 2_000), null, "a different key rejects");
	const [payload, signature] = token.split(".");
	assert.equal(await verifySessionToken(SECRET, `${payload}x.${signature}`, 2_000), null, "a tampered payload rejects");
	assert.equal(await verifySessionToken(SECRET, `${payload}.${signature.slice(0, -2)}aa`, 2_000), null, "a tampered signature rejects");
	assert.equal(await verifySessionToken(SECRET, "garbage", 2_000), null);
	assert.equal(await verifySessionToken(SECRET, "", 2_000), null);
});

test("sessions expire on the TTL and future-dated tokens are rejected", async () => {
	const { token } = await mintSessionToken(SECRET, "Ada", 1_000);
	assert.notEqual(await verifySessionToken(SECRET, token, 1_000 + SESSION_TTL_MS - 1), null);
	assert.equal(await verifySessionToken(SECRET, token, 1_000 + SESSION_TTL_MS + 1), null, "past the TTL rejects");
	const future = await mintSessionToken(SECRET, "Ada", 10 * 60_000);
	assert.equal(await verifySessionToken(SECRET, future.token, 1_000), null, "a token minted in the future rejects");
});

test("display names stay bounded and header-safe", async () => {
	await assert.rejects(() => mintSessionToken(SECRET, ""), /Display names/u);
	await assert.rejects(() => mintSessionToken(SECRET, "x".repeat(80)), /Display names/u);
	await assert.rejects(() => mintSessionToken(SECRET, "a\nb"), /Display names/u);
	await assert.rejects(() => mintSessionToken(""," Ada"), /ADMIN_TOKEN|Display names/u);
});

test("the sliding-window rate limit admits up to the cap and recovers after the window", () => {
	const windows = new Map();
	for (let index = 0; index < 3; index += 1) assert.equal(admitRateLimited(windows, "user-a", 1_000 + index, { limit: 3, windowMs: 10_000 }), true);
	assert.equal(admitRateLimited(windows, "user-a", 1_500, { limit: 3, windowMs: 10_000 }), false, "the cap holds");
	assert.equal(admitRateLimited(windows, "user-b", 1_500, { limit: 3, windowMs: 10_000 }), true, "keys are independent");
	assert.equal(admitRateLimited(windows, "user-a", 12_000, { limit: 3, windowMs: 10_000 }), true, "the window slides");
});
