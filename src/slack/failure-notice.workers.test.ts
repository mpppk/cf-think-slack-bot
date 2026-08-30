import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackBot } from "./bot";
import {
	classifyFailure,
	createFailureNotice,
	extractHttpStatus,
	formatFailureNotice,
} from "./failure-notice";
import {
	consumePendingFailureNotice,
	isMessengerPatchInstalled,
	__test__ as patchTest,
	setPendingFailureNotice,
} from "./messenger-patch";

// workerd 環境で実行（ADR 0022）。*.workers.test.ts の命名で check:conventions を満たす

describe("failure-notice: extractHttpStatus", () => {
	it("APICallError の statusCode を拾う", () => {
		expect(extractHttpStatus({ statusCode: 429 })).toBe(429);
		expect(extractHttpStatus({ status: 500 })).toBe(500);
		expect(extractHttpStatus({ status_code: 401 })).toBe(401);
	});

	it("cause の再帰で拾う", () => {
		expect(extractHttpStatus({ cause: { statusCode: 403 } })).toBe(403);
		expect(extractHttpStatus({ cause: { cause: { status: 429 } } })).toBe(429);
	});

	it("対応するフィールドが無ければ null", () => {
		expect(extractHttpStatus(new Error("boom"))).toBeNull();
		expect(extractHttpStatus({})).toBeNull();
		expect(extractHttpStatus(null)).toBeNull();
	});
});

describe("failure-notice: classifyFailure", () => {
	it("429 は rate_limited", () => {
		expect(classifyFailure({ statusCode: 429 })).toEqual({
			classification: "rate_limited",
			httpStatus: 429,
		});
	});

	it("401 は unauthorized", () => {
		expect(classifyFailure({ statusCode: 401 })).toEqual({
			classification: "unauthorized",
			httpStatus: 401,
		});
	});

	it("403 は forbidden", () => {
		expect(classifyFailure({ statusCode: 403 })).toEqual({
			classification: "forbidden",
			httpStatus: 403,
		});
	});

	it("404 は not_found", () => {
		expect(classifyFailure({ statusCode: 404 })).toEqual({
			classification: "not_found",
			httpStatus: 404,
		});
	});

	it("500 は upstream_error", () => {
		expect(classifyFailure({ statusCode: 500 })).toEqual({
			classification: "upstream_error",
			httpStatus: 500,
		});
		expect(classifyFailure({ statusCode: 503 })).toEqual({
			classification: "upstream_error",
			httpStatus: 503,
		});
	});

	it("400 は bad_request（context_overflow パターンが無いとき）", () => {
		expect(
			classifyFailure({ statusCode: 400, message: "Bad Request" }),
		).toEqual({
			classification: "bad_request",
			httpStatus: 400,
		});
	});

	it("context_overflow は status が 400 でも overflow を優先", () => {
		const err = new Error("prompt is too long: exceeds context length");
		(err as unknown as Record<string, unknown>).statusCode = 400;
		expect(classifyFailure(err)).toEqual({
			classification: "context_overflow",
			httpStatus: 400,
		});
	});

	it("context_length_exceeded 文字列でも overflow", () => {
		expect(classifyFailure(new Error("context_length_exceeded"))).toEqual({
			classification: "context_overflow",
			httpStatus: 400,
		});
	});

	it("status が無いエラーは unknown", () => {
		expect(classifyFailure(new Error("some random failure"))).toEqual({
			classification: "unknown",
			httpStatus: null,
		});
	});

	it("メッセージに rate limit 文字列があれば rate_limited（status無しでも）", () => {
		expect(classifyFailure(new Error("Rate limit exceeded"))).toEqual({
			classification: "rate_limited",
			httpStatus: 429,
		});
	});
});

describe("failure-notice: formatFailureNotice", () => {
	it("分類とHTTP statusだけを含む日本語定型文", () => {
		expect(formatFailureNotice("rate_limited", 429)).toBe(
			"生成に失敗しました（rate_limited / HTTP 429）。少し待って同じスレッドで再送してください。",
		);
		expect(formatFailureNotice("unknown", null)).toBe(
			"生成に失敗しました（unknown / HTTP unknown）。少し待って同じスレッドで再送してください。",
		);
	});

	it("生のエラーメッセージを含まない", () => {
		const raw =
			"my secret prompt is hello world, https://example.com/image.jpg";
		const notice = createFailureNotice(new Error(raw));
		expect(notice).not.toContain("hello");
		expect(notice).not.toContain("secret");
		expect(notice).not.toContain("https://");
	});

	it("allowlist外の status でも生が漏れない", () => {
		// 418 I'm a teapot は allowlist に無いが bad_request へ丸めて生を出さない
		const err = Object.assign(
			new Error("418 with body: secret prompt 'attack'"),
			{
				statusCode: 418,
			},
		);
		const notice = createFailureNotice(err);
		expect(notice).not.toContain("secret");
		expect(notice).not.toContain("attack");
		expect(notice).not.toContain("418 with body");
		// 分類と HTTP status だけが出る
		expect(notice).toMatch(/bad_request \/ HTTP 418/);
	});

	it("4xx がリクエスト内容をエコーバックしても生を出さない（ADR 0009）", () => {
		const rawPrompt = "ユーザの検索キーワード: 機密情報123";
		const err = Object.assign(
			new Error(`400 Bad Request: prompt "${rawPrompt}" is invalid`),
			{ statusCode: 400 },
		);
		const notice = createFailureNotice(err);
		expect(notice).not.toContain("機密情報");
		expect(notice).not.toContain(rawPrompt);
		expect(notice).toBe(
			"生成に失敗しました（bad_request / HTTP 400）。少し待って同じスレッドで再送してください。",
		);
	});
});

describe("SlackBot.onChatError: allowlist 投稿とログ分離", () => {
	function createBot(): SlackBot {
		const bot = Object.create(SlackBot.prototype) as SlackBot;
		(bot as unknown as { env: Env }).env = {
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
			OPENROUTER_API_KEY: "test",
		} as Env;
		// resolveFailureThreadId を固定値に差し替え、activeChannel の getter に依存しない
		(bot as unknown as Record<string, unknown>).resolveFailureThreadId = () =>
			"slack:C123:123.456";
		return bot;
	}

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("生のエラーメッセージをスレッドへ出さず、分類とHTTP statusだけを返す", () => {
		const bot = createBot();
		const raw =
			"Error: 429 Too Many Requests with prompt 'secret keyword' and https://evil.com/img.jpg";
		const err = Object.assign(new Error(raw), { statusCode: 429 });

		const returned = bot.onChatError(err, {
			stage: "stream",
			requestId: "req-123",
			messagesPersisted: true,
		});

		const message =
			returned instanceof Error ? returned.message : String(returned);
		expect(message).toContain("rate_limited");
		expect(message).toContain("429");
		expect(message).not.toContain("secret keyword");
		expect(message).not.toContain("https://evil.com");
		expect(message).not.toContain("Too Many Requests");
	});

	it("allowlistに無いエラーでも生が漏れず unknown で通知される", () => {
		const bot = createBot();
		const raw =
			"some bizarre provider error: prompt='top secret' url='https://private.example.com/secret.jpg'";
		const err = new Error(raw);
		// status 無し -> unknown
		const returned = bot.onChatError(err, { stage: "turn" });
		const message =
			returned instanceof Error ? returned.message : String(returned);
		expect(message).not.toContain("top secret");
		expect(message).not.toContain("https://private.example.com");
		expect(message).not.toContain("bizarre");
		expect(message).toMatch(/unknown \/ HTTP unknown/);
	});

	it("詳細は Workers Logs（console.error）に出る", () => {
		const bot = createBot();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const raw = "secret prompt leaked in 400";
		const err = Object.assign(new Error(raw), { statusCode: 400 });

		bot.onChatError(err, { stage: "stream", requestId: "req-xyz" });

		expect(errorSpy).toHaveBeenCalled();
		const logged = errorSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
		// ログには生が載る（Workers Logs でのみ見られる）
		expect(JSON.stringify(logged)).toContain("secret prompt");
		expect(logged).toMatchObject({
			op: "slack_generation_failure",
			classification: "bad_request",
			httpStatus: 400,
		});
	});

	it("通知文は日本語の定型文（例文と一致）", () => {
		const bot = createBot();
		const err = Object.assign(new Error("429"), { statusCode: 429 });
		const returned = bot.onChatError(err, { stage: "stream" });
		const message =
			returned instanceof Error ? returned.message : String(returned);
		expect(message).toBe(
			"生成に失敗しました（rate_limited / HTTP 429）。少し待って同じスレッドで再送してください。",
		);
	});

	it("pending notice が threadId に紐付けて登録される", () => {
		const bot = createBot();
		const err = Object.assign(new Error("429"), { statusCode: 429 });
		bot.onChatError(err, { stage: "stream" });
		const pending = consumePendingFailureNotice("slack:C123:123.456");
		expect(pending).toContain("rate_limited");
		expect(pending).toContain("429");
		// consume したので次は undefined
		expect(consumePendingFailureNotice("slack:C123:123.456")).toBeUndefined();
	});

	it("context_overflow も正しく分類される", () => {
		const bot = createBot();
		const err = Object.assign(new Error("prompt is too long"), {
			statusCode: 400,
		});
		const returned = bot.onChatError(err, { stage: "stream" });
		const message =
			returned instanceof Error ? returned.message : String(returned);
		expect(message).toContain("context_overflow");
	});

	it("上流の 5xx は upstream_error", () => {
		const bot = createBot();
		const err = Object.assign(new Error("500 Internal Server Error"), {
			statusCode: 500,
		});
		const returned = bot.onChatError(err, { stage: "stream" });
		const message =
			returned instanceof Error ? returned.message : String(returned);
		expect(message).toContain("upstream_error");
		expect(message).toContain("500");
	});
});

describe("messenger-patch: generic 置換", () => {
	it("パッチがインストールされている", () => {
		expect(isMessengerPatchInstalled()).toBe(true);
	});

	it("set/consume が threadId ごとに分離される", () => {
		setPendingFailureNotice("slack:C1:1.1", "notice-1");
		setPendingFailureNotice("slack:C2:2.2", "notice-2");
		expect(consumePendingFailureNotice("slack:C1:1.1")).toBe("notice-1");
		expect(consumePendingFailureNotice("slack:C2:2.2")).toBe("notice-2");
		expect(consumePendingFailureNotice("slack:C1:1.1")).toBeUndefined();
	});

	it("generic 置換のフォールバックは unknown（生を出さない）", () => {
		const notice = patchTest.noticeFromError(
			new Error("totally unknown bizarre error with secret"),
		);
		expect(notice).not.toContain("secret");
		expect(notice).toContain("unknown");
	});

	it("dedupe はサイレントのまま（pending を消さない限り投稿されない）", () => {
		// dedupe 時は onChatError が呼ばれず pending も無いので、
		// answer の post ラッパは generic が来ても fallback unknown を出すが、
		// 実際 dedupe は deliverMessengerReply 自体が呼ばれないため投稿自体が無い。
		// ここでは pending が無い状態で consume が undefined であることを確認する。
		expect(consumePendingFailureNotice("slack:DEDUP:0.0")).toBeUndefined();
	});
});
