import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "./index";
import { createSlackSignature } from "./slack/signature";
import { SLACK_WEBHOOK_PATH } from "./slack/webhook";

// ここで固定しているのは **scripts/smoke.sh がデプロイ済み環境に対して確認するのと
// 同じ外形の契約**。adapter が入って実装が入れ替わっても、この振る舞いは変えない。
const BASE_URL = "https://cf-think-slack-bot.example.com";

// Worker の `fetch` は Cloudflare が付与するプロパティ付きの Request を受け取る。
// 素の `new Request()` は型が合わないので、CF が案内している別名を使う。
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
type IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

/**
 * `waitUntil` に渡された処理を集める最小の ExecutionContext。
 * 本番と同じ経路(ctx あり)を通しつつ、非同期配送の完了まで待てるようにする。
 */
function testExecutionContext(): {
	ctx: ExecutionContext;
	settled: () => Promise<void>;
} {
	const pending: Promise<unknown>[] = [];
	const ctx = {
		waitUntil(promise: Promise<unknown>) {
			pending.push(promise);
		},
		passThroughOnException() {},
	} as unknown as ExecutionContext;
	return {
		ctx,
		settled: async () => {
			await Promise.all(pending);
		},
	};
}

async function dispatch(request: IncomingRequest): Promise<Response> {
	// 本番と同じ経路。ctx があると webhook は即 ack し、Think への配送は
	// waitUntil の中で走る(仕様§4.1)。配送完了まで待ってから返す。
	const { ctx, settled } = testExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await settled();
	return response;
}

async function signedRequest(payload: unknown): Promise<IncomingRequest> {
	const signingSecret = env.SLACK_SIGNING_SECRET;
	if (!signingSecret) {
		throw new Error(
			"SLACK_SIGNING_SECRET がテスト環境に無い(vitest.config.ts の bindings を確認)",
		);
	}
	const body = JSON.stringify(payload);
	const timestamp = Math.floor(Date.now() / 1000);
	return new IncomingRequest(`${BASE_URL}${SLACK_WEBHOOK_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-slack-request-timestamp": String(timestamp),
			"x-slack-signature": await createSlackSignature(
				signingSecret,
				timestamp,
				body,
			),
		},
		body,
	});
}

describe("GET /health", () => {
	it("200 と環境名を返す", async () => {
		const response = await dispatch(new IncomingRequest(`${BASE_URL}/health`));
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ ok: true });
	});
});

describe(`POST ${SLACK_WEBHOOK_PATH}`, () => {
	it("署名が無ければ 401 を返す", async () => {
		const response = await dispatch(
			new IncomingRequest(`${BASE_URL}${SLACK_WEBHOOK_PATH}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "url_verification", challenge: "x" }),
			}),
		);
		expect(response.status).toBe(401);
	});

	it("署名が壊れていれば 401 を返す", async () => {
		const request = await signedRequest({
			type: "url_verification",
			challenge: "x",
		});
		request.headers.set("x-slack-signature", "v0=deadbeef");
		const response = await dispatch(request);
		expect(response.status).toBe(401);
	});

	it("正しい署名の url_verification に challenge をそのまま返す", async () => {
		const challenge = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P";
		const response = await dispatch(
			await signedRequest({ type: "url_verification", challenge }),
		);
		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe(challenge);
	});

	it("正しい署名のイベントに即 ack を返す(Thinkの完了を待たない)", async () => {
		const response = await dispatch(
			await signedRequest({
				type: "event_callback",
				event: { type: "app_mention" },
			}),
		);
		// 仕様§4.1: 即座に ack を返し、実処理は非同期で行う。Think の処理(LLM呼び出し)を
		// 待つと3秒に間に合わずSlackがリトライする。
		// **この 202 は「Thinkへ渡していない」ことを意味しない。** 配線が生きていることは
		// src/slack/webhook.workers.test.ts の「Think へ配送する」で別途検証している。
		expect(response.status).toBe(202);
	});
});
