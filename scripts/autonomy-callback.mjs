const callbackUrl = process.env.AUTONOMY_CALLBACK_URL;
const token = process.env.AUTONOMY_GITHUB_TOKEN;
if (!callbackUrl || !token) throw new Error("Autonomy callback configuration is missing.");

const [phase, message, result = ""] = process.argv.slice(2);
if (!phase || !message) throw new Error("Usage: autonomy-callback <phase> <message> [result]");

const body = JSON.stringify({
	room: process.env.AUTONOMY_ROOM,
	requestId: process.env.AUTONOMY_REQUEST_ID,
	phase,
	message,
	result: result || undefined,
});
const response = await fetch(callbackUrl, {
	method: "POST",
	headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
	body,
});
if (!response.ok) throw new Error(`Callback failed (${response.status})`);
