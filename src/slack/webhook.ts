import { verifySlackSignature } from "./signature";

/**
 * Slack Webhook の受け口。Slack App の Event Subscriptions に登録する URL
 * (README / ADR 0023 の manifest と一致させること)。
 */
export const SLACK_WEBHOOK_PATH = "/messengers/slack/webhook";

export async function handleSlackWebhook(
	request: Request,
	env: Env,
): Promise<Response> {
	const signingSecret = env.SLACK_SIGNING_SECRET;
	if (!signingSecret) {
		// secret 未設定のまま 200 を返すと「検証していないこと」に気付けないまま
		// 動いてしまう。閉じる側に倒し、理由は Workers Logs に残す(ADR 0018)。
		console.error({
			msg: "slack webhook rejected: SLACK_SIGNING_SECRET is not configured",
			op: "slack_webhook",
		});
		return new Response("Unauthorized", { status: 401 });
	}

	// 署名はボディの生バイト列に対して作られるので、パースの前に文字列で受ける。
	const body = await request.text();
	const verified = await verifySlackSignature({
		signingSecret,
		timestamp: request.headers.get("x-slack-request-timestamp"),
		signature: request.headers.get("x-slack-signature"),
		body,
	});
	if (!verified) {
		return new Response("Unauthorized", { status: 401 });
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return new Response("Bad Request", { status: 400 });
	}

	// Event Subscriptions の URL 登録時と、Slack が疎通を再確認するときに来る。
	// challenge をそのまま返すことが要求で、これは adapter が入った後も変わらない。
	if (isUrlVerification(payload)) {
		return new Response(payload.challenge, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	}

	// ここから先(イベントの配送・Think への受け渡し)は後続のPRで実装する。
	// Slack は3秒で ack を要求するので、実装が入るまでも受理だけは返しておく。
	return new Response(null, { status: 202 });
}

function isUrlVerification(
	payload: unknown,
): payload is { type: "url_verification"; challenge: string } {
	return (
		typeof payload === "object" &&
		payload !== null &&
		"type" in payload &&
		payload.type === "url_verification" &&
		"challenge" in payload &&
		typeof payload.challenge === "string"
	);
}
