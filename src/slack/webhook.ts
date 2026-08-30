import { getAgentByName } from "agents";
import { logError, logInfo } from "../observability/log";
import { verifySlackSignature } from "./signature";

/**
 * ルートの Think エージェント(DO)の名前。Think は messenger ごとに1つの
 * ルートが Chat SDK runtime を持ち、ChatSDK thread ごとに sub-agent
 * (ThreadAgent) を生成する。名前は固定し、Slack の thread id (`slack:{channel}:{threadTs}`)
 * と衝突しないものにする(ADR 0002)。
 */
const ROOT_AGENT_NAME = "root";

/**
 * Think への配送を諦めるまでの時間。
 *
 * ハングしたまま invocation が終わらないと Workers Logs には何も出力されない
 * (ログは呼び出し完了時にフラッシュされる)ため、必ず終わらせて記録を残す。
 */
const DISPATCH_TIMEOUT_MS = 25_000;

/**
 * Slack Webhook の受け口。Slack App の Event Subscriptions に登録する URL
 * (README / ADR 0023 の manifest と一致させること)。
 */
export const SLACK_WEBHOOK_PATH = "/messengers/slack/webhook";

/** この経路のログに付く `op`。`wrangler tail --search` で絞るためのキー。 */
const OP = "slack_webhook";

export async function handleSlackWebhook(
	request: Request,
	env: Env,
	ctx?: ExecutionContext,
): Promise<Response> {
	const signingSecret = env.SLACK_SIGNING_SECRET;
	if (!signingSecret) {
		// secret 未設定のまま 200 を返すと「検証していないこと」に気付けないまま
		// 動いてしまう。閉じる側に倒し、理由は Workers Logs に残す(ADR 0018)。
		logError(OP, "rejected: SLACK_SIGNING_SECRET is not configured");
		return new Response("Unauthorized", { status: 401 });
	}

	// 署名はボディの生バイト列に対して作られるので、パースの前に文字列で受ける。
	const body = await request.text();
	const timestamp = request.headers.get("x-slack-request-timestamp");
	const signature = request.headers.get("x-slack-signature");
	const verified = await verifySlackSignature({
		signingSecret,
		timestamp,
		signature,
		body,
	});
	if (!verified) {
		// Slack App のセットアップで最も多く踏むのがここ(secretの取り違え・
		// 環境の取り違え)。ヘッダの有無まで残しておくと、「Slackから来ていない」
		// のか「secretが違う」のかがログだけで切り分けられる。
		logError(OP, "rejected: invalid Slack signature", {
			hasTimestamp: timestamp !== null,
			hasSignature: signature !== null,
		});
		return new Response("Unauthorized", { status: 401 });
	}

	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		logError(OP, "rejected: body is not JSON");
		return new Response("Bad Request", { status: 400 });
	}

	// Event Subscriptions の URL 登録時と、Slack が疎通を再確認するときに来る。
	// challenge をそのまま返すことが要求で、これは adapter が入った後も変わらない。
	if (isUrlVerification(payload)) {
		logInfo(OP, "url_verification: challenge を返した");
		return new Response(payload.challenge, {
			status: 200,
			headers: { "content-type": "text/plain" },
		});
	}

	// 実装が入るまで、Slackからイベントが届いていることを外から観測できるのは
	// このログだけ(botはまだ発言しないので Slack の画面には何も出ない)。
	logInfo(OP, "イベントを受理した", describeEvent(payload, request));

	// 署名検証で request.text() により body を読み切っているため、同じ内容で
	// Request を作り直して Think の messenger ルートへ渡す。
	// Think は ChatSDK thread ごとに sub-agent を作る (conversation: "thread" 既定)
	// ため、Slack Thread -> ChatSDK Thread -> Thread Agent の束縛は Think 側で
	// 保たれる(ADR 0002, ADR 0003)。
	const forwardRequest = new Request(request.url, {
		method: request.method,
		headers: new Headers(request.headers),
		body,
	});

	const dispatchToThink = async (): Promise<Response> => {
		const stub = await getAgentByName(env.THREAD_AGENT, ROOT_AGENT_NAME);
		return await stub.fetch(forwardRequest);
	};

	// 仕様§4.1: 即座に ack を返し、実処理は非同期で行う。
	// Think の処理(LLM呼び出しを含む)を待つと3秒に間に合わずSlackがリトライし、
	// 同じイベントが何度も配送される。ack は adapter ではなくここで返す。
	if (ctx) {
		ctx.waitUntil(
			(async () => {
				try {
					const response = await withTimeout(
						dispatchToThink(),
						DISPATCH_TIMEOUT_MS,
					);
					logInfo(OP, "Thinkへ配送した", { status: response.status });
				} catch (error) {
					// タイムアウトを入れているのは、ハングしたまま invocation が終わらないと
					// Workers Logs に何も出ず原因調査ができなくなるため。
					logError(OP, "Thinkへの配送に失敗した", {
						error: String(error).slice(0, 500),
					});
				}
			})(),
		);
		return new Response(null, { status: 202 });
	}

	// ctx が無い経路(テスト)では同期的に配送し、Think の応答をそのまま返す。
	// 202 を固定するとThinkへ届いているかを検証できなくなる。
	try {
		const response = await dispatchToThink();
		logInfo(OP, "Thinkへ配送した", { status: response.status });
		return response;
	} catch (error) {
		logError(OP, "Thinkへの配送に失敗した", {
			error: String(error).slice(0, 500),
		});
		return new Response("Internal Server Error", { status: 500 });
	}
}

/** `promise` が `ms` 以内に解決しなければ reject する。ハング時にログを残すため。 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`think_dispatch_timeout after ${ms}ms`));
		}, ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/**
 * ログに残すイベントの素性。
 *
 * **本文(`event.text`)とファイルURLは載せない。** 会話の中身が Workers Logs に
 * 残り続けることになるし、経路の確認にはイベントの種類と宛先だけで足りる。
 * デバッグで本文が要るときはローカル(`bun run dev` + トンネル)で見ること。
 *
 * ここは観測だけを行う。リトライの重複排除・bot自身のイベント除外といった
 * 判断は adapter に委譲する(ADR 0021)ので、ここで弾いてはいけない。
 */
function describeEvent(
	payload: unknown,
	request: Request,
): Record<string, unknown> {
	const event = readProperty(payload, "event");
	return {
		payloadType: readString(payload, "type"),
		eventId: readString(payload, "event_id"),
		teamId: readString(payload, "team_id"),
		eventType: readString(event, "type"),
		eventSubtype: readString(event, "subtype"),
		channelId: readString(event, "channel"),
		channelType: readString(event, "channel_type"),
		userId: readString(event, "user"),
		botId: readString(event, "bot_id"),
		ts: readString(event, "ts"),
		threadTs: readString(event, "thread_ts"),
		// リトライで再送されたものかどうか。ackが3秒に間に合っているかが分かる。
		retryNum: request.headers.get("x-slack-retry-num") ?? undefined,
		retryReason: request.headers.get("x-slack-retry-reason") ?? undefined,
	};
}

function readProperty(source: unknown, key: string): unknown {
	if (typeof source !== "object" || source === null) {
		return undefined;
	}
	return (source as Record<string, unknown>)[key];
}

function readString(source: unknown, key: string): string | undefined {
	const value = readProperty(source, key);
	return typeof value === "string" ? value : undefined;
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
