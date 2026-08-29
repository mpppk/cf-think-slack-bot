import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackSignature } from "./signature";
import { handleSlackWebhook, SLACK_WEBHOOK_PATH } from "./webhook";

// このファイルが固定するのは **Workers Logs に何が出るか**。
// 実装が入るまで、Slackからイベントが届いていることを外から確認できるのは
// このログだけなので、フィールドが消えると動作確認の手段ごと失われる。

const BASE_URL = "https://cf-think-slack-bot.example.com";

const APP_MENTION = {
	type: "event_callback",
	event_id: "Ev0PV52K21",
	team_id: "T0001",
	event: {
		type: "app_mention",
		user: "U061F7AUR",
		text: "<@U0LAN0Z89> こんにちは",
		channel: "C0LAN2Q65",
		channel_type: "channel",
		ts: "1515449522.000016",
		thread_ts: "1515449522.000016",
	},
};

function signingSecret(): string {
	const secret = env.SLACK_SIGNING_SECRET;
	if (!secret) {
		throw new Error(
			"SLACK_SIGNING_SECRET がテスト環境に無い(vitest.config.ts の bindings を確認)",
		);
	}
	return secret;
}

async function signedRequest(
	payload: unknown,
	headers: Record<string, string> = {},
): Promise<Request> {
	const body = JSON.stringify(payload);
	const timestamp = Math.floor(Date.now() / 1000);
	return new Request(`${BASE_URL}${SLACK_WEBHOOK_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-slack-request-timestamp": String(timestamp),
			"x-slack-signature": await createSlackSignature(
				signingSecret(),
				timestamp,
				body,
			),
			...headers,
		},
		body,
	});
}

/** 直近の構造化ログ1件を取り出す。 */
function lastRecord(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
	const call = spy.mock.calls.at(-1);
	expect(call, "ログが1件も出ていません").toBeDefined();
	return (call as unknown[])[0] as Record<string, unknown>;
}

/** `イベントを受理した` のログを探す。Think への配送ログが後に追加されたため lastRecord では届かない。 */
function acceptedRecord(
	spy: ReturnType<typeof vi.spyOn>,
): Record<string, unknown> {
	for (let i = spy.mock.calls.length - 1; i >= 0; i--) {
		const rec = (spy.mock.calls[i] as unknown[])[0] as Record<string, unknown>;
		if (rec.msg === "イベントを受理した") {
			return rec;
		}
	}
	throw new Error("イベントを受理した ログが見つかりません");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("受理したイベントのログ", () => {
	it("経路・種類・宛先が分かるフィールドを出す", async () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleSlackWebhook(await signedRequest(APP_MENTION), env);

		expect(acceptedRecord(info)).toMatchObject({
			op: "slack_webhook",
			payloadType: "event_callback",
			eventId: "Ev0PV52K21",
			teamId: "T0001",
			eventType: "app_mention",
			channelId: "C0LAN2Q65",
			channelType: "channel",
			userId: "U061F7AUR",
			ts: "1515449522.000016",
			threadTs: "1515449522.000016",
		});
	});

	it("メッセージ本文はログに残さない", async () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleSlackWebhook(await signedRequest(APP_MENTION), env);

		expect(JSON.stringify(acceptedRecord(info))).not.toContain("こんにちは");
	});

	it("来ていないフィールドはキーごと落とす", async () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleSlackWebhook(
			await signedRequest({
				type: "event_callback",
				event: { type: "message", channel_type: "im" },
			}),
			env,
		);

		// DM にスレッドが無い場合など。`undefined` を載せると
		// 「空で来た」のか「そもそも無い」のか読めなくなる。
		expect(acceptedRecord(info)).not.toHaveProperty("threadTs");
	});

	it("リトライで再送されたことが分かる", async () => {
		const info = vi.spyOn(console, "log").mockImplementation(() => {});

		await handleSlackWebhook(
			await signedRequest(APP_MENTION, {
				"x-slack-retry-num": "2",
				"x-slack-retry-reason": "http_timeout",
			}),
			env,
		);

		expect(acceptedRecord(info)).toMatchObject({
			retryNum: "2",
			retryReason: "http_timeout",
		});
	});
});

describe("弾いたリクエストのログ", () => {
	it("署名が違うとき、ヘッダの有無まで残す", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const request = await signedRequest(APP_MENTION);
		request.headers.set("x-slack-signature", "v0=deadbeef");
		await handleSlackWebhook(request, env);

		// secret の取り違えなら両方 true、Slack 以外からの直接アクセスなら false。
		expect(lastRecord(error)).toMatchObject({
			op: "slack_webhook",
			hasTimestamp: true,
			hasSignature: true,
		});
	});

	it("署名ヘッダが無いとき、その旨が分かる", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		await handleSlackWebhook(
			new Request(`${BASE_URL}${SLACK_WEBHOOK_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(APP_MENTION),
			}),
			env,
		);

		expect(lastRecord(error)).toMatchObject({
			hasTimestamp: false,
			hasSignature: false,
		});
	});
});
