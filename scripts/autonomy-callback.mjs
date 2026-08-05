import { createHmac } from "node:crypto";

const callbackUrl = process.env.AUTONOMY_CALLBACK_URL;
const secret = process.env.AUTONOMY_CALLBACK_SECRET;
if (!callbackUrl || !secret) throw new Error("Autonomy callback configuration is missing.");

const [phase, message, result = ""] = process.argv.slice(2);
if (!phase || !message) throw new Error("Usage: autonomy-callback <phase> <message> [result]");

const body = JSON.stringify({
	room: process.env.AUTONOMY_ROOM,
	requestId: process.env.AUTONOMY_REQUEST_ID,
	phase,
	message,
	result: result || undefined,
});
const signature = createHmac("sha256", secret).update(body).digest("hex");
const response = await fetch(callbackUrl, {
	method: "POST",
	headers: { "Content-Type": "application/json", "x-autonomy-signature": `sha256=${signature}` },
	body,
});
if (!response.ok) throw new Error(`Callback failed (${response.status})`);
