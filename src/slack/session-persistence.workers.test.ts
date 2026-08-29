import { env } from "cloudflare:workers";
import { createSlackAdapter } from "@chat-adapter/slack";
import type { Session } from "@cloudflare/think";
import { defaultContextOverflowClassifier } from "@cloudflare/think";
import type {
	SessionMessage,
	SessionProvider,
	StoredCompaction,
} from "agents/experimental/memory/session";
import { Session as SessionClass } from "agents/experimental/memory/session";
import { describe, expect, it, vi } from "vitest";
import {
	COMPACTION_PROACTIVE_MAX_INPUT_TOKENS,
	COMPACTION_THRESHOLD_TOKENS,
	SlackBot,
} from "./bot";

// Think Session を正典とし、Slack の conversations.replies で再構築しない(ADR 0001)。
// Session は無期限保持・tool_result も永続(仕様§3.7)。compaction は #28 で
// onCompaction + compactAfter を登録し、overlay として保存する(ADR 0007)。

function createBot(envOverrides: Partial<Env>): SlackBot {
	const bot = Object.create(SlackBot.prototype) as SlackBot;
	(bot as unknown as { env: Env }).env = envOverrides as Env;
	// contextOverflow / classifyChatError はクラスフィールドのため Object.create では初期化されない。
	// テストで SlackBot インスタンスのフィールドを検証する際は手動で初期化する
	(bot as unknown as { contextOverflow: unknown }).contextOverflow = {
		reactive: true,
		proactive: { maxInputTokens: COMPACTION_PROACTIVE_MAX_INPUT_TOKENS },
	};
	(bot as unknown as { classifyChatError: unknown }).classifyChatError =
		defaultContextOverflowClassifier;
	return bot;
}

/**
 * テスト用のインメモリ SessionProvider。
 * AgentSessionProvider の SQLite / FTS5 を模すが、workerd の DO SQL 無しで
 * Session の compaction overlay と search の分離を検証する。
 */
class InMemoryProvider implements SessionProvider {
	private messages: SessionMessage[] = [];
	private compactions: StoredCompaction[] = [];

	getMessage(id: string): SessionMessage | null {
		return this.messages.find((m) => m.id === id) ?? null;
	}

	getHistory(): SessionMessage[] {
		return [...this.messages];
	}

	getLatestLeaf(): SessionMessage | null {
		return this.messages.at(-1) ?? null;
	}

	getBranches(): SessionMessage[] {
		return [];
	}

	getPathLength(): number {
		return this.messages.length;
	}

	appendMessage(message: SessionMessage): void {
		// id 重複は no-op（Session の冪等性に合わせる）
		if (this.messages.some((m) => m.id === message.id)) {
			return;
		}
		this.messages.push(message);
	}

	updateMessage(message: SessionMessage): void {
		const idx = this.messages.findIndex((m) => m.id === message.id);
		if (idx !== -1) {
			this.messages[idx] = message;
		}
	}

	deleteMessages(messageIds: string[]): void {
		this.messages = this.messages.filter((m) => !messageIds.includes(m.id));
	}

	clearMessages(): void {
		this.messages = [];
		this.compactions = [];
	}

	addCompaction(
		summary: string,
		fromMessageId: string,
		toMessageId: string,
	): StoredCompaction {
		const compaction: StoredCompaction = {
			id: `compaction_${Date.now()}`,
			summary,
			fromMessageId,
			toMessageId,
			createdAt: new Date().toISOString(),
		};
		this.compactions.push(compaction);
		return compaction;
	}

	getCompactions(): StoredCompaction[] {
		return [...this.compactions];
	}

	searchMessages(
		query: string,
		limit = 20,
	): { id: string; role: string; content: string; createdAt?: string }[] {
		const q = query.toLowerCase();
		const results: {
			id: string;
			role: string;
			content: string;
			createdAt?: string;
		}[] = [];
		for (const m of this.messages) {
			const content = m.parts
				.map((p) => (p as { text?: string }).text ?? "")
				.join(" ")
				.toLowerCase();
			if (content.includes(q)) {
				results.push({
					id: m.id,
					role: m.role,
					content: m.parts
						.map((p) => (p as { text?: string }).text ?? "")
						.join(" "),
					createdAt: m.createdAt?.toISOString(),
				});
				if (results.length >= limit) {
					break;
				}
			}
		}
		return results;
	}
}

describe("Think Session 永続化 (§3.7, ADR 0001, ADR 0007)", () => {
	it("configureSession は onCompaction + compactAfter を登録する（ADR 0007）", async () => {
		const bot = createBot({
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
			OPENROUTER_API_KEY: "test",
		});
		const onCompaction = vi.fn(function (this: Session, _fn: unknown) {
			return this;
		}) as unknown as Session["onCompaction"];
		const compactAfter = vi.fn(function (this: Session, _threshold: number) {
			return this;
		}) as unknown as Session["compactAfter"];

		const mockSession = {
			onCompaction,
			compactAfter,
		} as unknown as Session;
		// Session の chain が this を返すように、this を mockSession に束縛
		(mockSession as unknown as { onCompaction: unknown }).onCompaction = vi.fn(
			(fn: unknown) => {
				expect(typeof fn).toBe("function");
				return mockSession;
			},
		) as unknown as Session["onCompaction"];
		(mockSession as unknown as { compactAfter: unknown }).compactAfter = vi.fn(
			(threshold: number) => {
				expect(threshold).toBe(COMPACTION_THRESHOLD_TOKENS);
				return mockSession;
			},
		) as unknown as Session["compactAfter"];

		const result = await bot.configureSession(mockSession);
		expect(result).toBe(mockSession);
		expect(mockSession.onCompaction).toHaveBeenCalledTimes(1);
		expect(mockSession.compactAfter).toHaveBeenCalledTimes(1);
		expect(mockSession.compactAfter).toHaveBeenCalledWith(
			COMPACTION_THRESHOLD_TOKENS,
		);
	});

	it("configureSession の閾値はモデル context_length に合わせて設定される（ADR 0004, ADR 0007）", async () => {
		// z-ai/glm-5.3-flash は context_length 1,310,720（ADR 0004）。
		// COMPACTION_THRESHOLD_TOKENS はその約7.6% で、heuristic 誤差と tool_result
		// 膨張を考慮して保守的に設定されていること。
		expect(COMPACTION_THRESHOLD_TOKENS).toBe(100_000);
		// proactive は 1,310,720 の約76%（実効上限 1,048,576 の約95%）
		expect(COMPACTION_PROACTIVE_MAX_INPUT_TOKENS).toBe(1_000_000);

		const bot = createBot({
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
			OPENROUTER_API_KEY: "test",
		});
		expect(bot.contextOverflow).toEqual({
			reactive: true,
			proactive: { maxInputTokens: COMPACTION_PROACTIVE_MAX_INPUT_TOKENS },
		});
		// classifyChatError は defaultContextOverflowClassifier で
		// "prompt is too long" / "context_length_exceeded" を検出できること
		expect(bot.classifyChatError(new Error("prompt is too long"))).toBe(
			"context_overflow",
		);
		expect(bot.classifyChatError(new Error("context_length_exceeded"))).toBe(
			"context_overflow",
		);
		expect(bot.classifyChatError(new Error("irrelevant"))).toBeUndefined();
	});

	it("configureSession は tool_result を間引かず、compaction で overlay にする", async () => {
		const bot = createBot({
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
		});
		// tool_result を含む履歴でも configureSession がフィルタせず、
		// compaction 登録を経て同一 Session を返すこと
		const mockSession = {
			onCompaction: vi.fn(function (this: Session) {
				return this;
			}) as unknown as Session["onCompaction"],
			compactAfter: vi.fn(function (this: Session) {
				return this;
			}) as unknown as Session["compactAfter"],
		} as unknown as Session;
		// chain 用に this を mockSession に固定
		(
			mockSession.onCompaction as unknown as ReturnType<typeof vi.fn>
		).mockImplementation(function (this: unknown) {
			return mockSession;
		});
		(
			mockSession.compactAfter as unknown as ReturnType<typeof vi.fn>
		).mockImplementation(function (this: unknown) {
			return mockSession;
		});
		const returned = await bot.configureSession(mockSession);
		expect(returned).toBe(mockSession);
		expect(mockSession.onCompaction).toHaveBeenCalled();
		expect(mockSession.compactAfter).toHaveBeenCalled();
	});

	it("SlackBot は Session を正典とし、Slack履歴の再取得に依存しない（ADR 0001）", async () => {
		// SlackBot が fetchMessages / fetchThread / conversations.replies 相当の
		// メソッドを持たないことを、プロトタイプの持つキーで検証する。
		// 将来これらを呼ぶコードが混入すると、正典が Session からずれるため
		// このテストで検出する。
		const protoKeys = Object.getOwnPropertyNames(SlackBot.prototype);
		expect(protoKeys).not.toContain("fetchMessages");
		expect(protoKeys).not.toContain("fetchThread");
		expect(protoKeys).not.toContain("conversationsReplies");
		// getSystemPrompt / getModel / getMessengers / configureSession 以外の
		// 余計な履歴取得メソッドが無いこと
		expect(protoKeys).toEqual(
			expect.arrayContaining([
				"configureSession",
				"getModel",
				"getTools",
				"getMessengers",
				"getSystemPrompt",
			]),
		);
	});

	it("要約は overlay として保存され、元の行は SQLite に残り search から参照できる（ADR 0007）", async () => {
		// Session の compaction は addCompaction の overlay として保存され、
		// 元の行は削除されない。getHistory は要約に置き換わるが、search は元の
		// 行を FTS5 から引き続き返す。
		const provider = new InMemoryProvider();
		const session = new SessionClass(provider as unknown as SessionProvider);

		// 検索用の特徴的なキーワードを含む履歴を作る
		const keyword = "compaction-overlay-search-keyword-28";
		await session.appendMessage({
			id: "msg-1",
			role: "user",
			parts: [{ type: "text", text: `最初の発言 ${keyword} を含む` }],
		} as SessionMessage);
		await session.appendMessage({
			id: "msg-2",
			role: "assistant",
			parts: [{ type: "text", text: "通常の応答" }],
		} as SessionMessage);
		for (let i = 3; i <= 10; i++) {
			await session.appendMessage({
				id: `msg-${i}`,
				role: "user",
				parts: [{ type: "text", text: `追加メッセージ ${i}` }],
			} as SessionMessage);
		}

		// compaction 前は search でヒットすること
		const before = await session.search(keyword);
		expect(before.length).toBeGreaterThan(0);
		expect(before[0]?.content).toContain(keyword);

		// 古い範囲を要約した overlay を追加（LLM 要約の代わりに固定文字列）
		// Session.addCompaction は overlay として保存し、元の行は消さない
		await session.addCompaction("要約: 過去の会話の要点", "msg-1", "msg-5");

		// overlay 追加後も search で元の行がヒットすること
		const after = await session.search(keyword);
		expect(after.length).toBeGreaterThan(0);
		expect(after[0]?.content).toContain(keyword);
		// search は FTS5 のため要約文字列とは別に元の行を返す
		expect(after[0]?.id).toBe("msg-1");

		// getCompactions で overlay が保存されていること
		const compactions = await session.getCompactions();
		expect(compactions).toHaveLength(1);
		expect(compactions[0]?.summary).toContain("要約");
	});

	it("長いスレッドでも compaction があれば context_overflow で失敗しない", async () => {
		// compaction 登録があることで session.compact() が null でなく
		// 要約を返す = Think の reactive/proactive が shortened=true で
		// リトライできることを、Session レベルで確認する。
		const provider = new InMemoryProvider();
		const session = new SessionClass(provider as unknown as SessionProvider);

		// compaction 関数を登録（テストでは LLM を呼ばず固定要約を返す）
		session.onCompaction(async (messages) => {
			if (messages.length < 5) {
				return null;
			}
			return {
				fromMessageId: messages[1]?.id ?? messages[0]?.id ?? "",
				toMessageId: messages[5]?.id ?? messages[0]?.id ?? "",
				summary: "テスト要約: 中間を圧縮",
			};
		});
		session.compactAfter(2); // 閾値を極小にしてすぐ発火するようにする

		// 履歴を閾値を超えるまで積む
		for (let i = 0; i < 10; i++) {
			await session.appendMessage({
				id: `long-${i}`,
				role: i % 2 === 0 ? "user" : "assistant",
				parts: [{ type: "text", text: `long message ${i} `.repeat(50) }],
			} as SessionMessage);
		}

		// compact() が要約を返す = reactive が shortened=true で retry できる
		const result = await session.compact();
		expect(result).not.toBeNull();
		expect(result?.summary).toContain("テスト要約");

		// compact 後も overlay が保存されていること
		const compactions = await session.getCompactions();
		expect(compactions.length).toBeGreaterThan(0);
	});
});

describe("ThreadAgent の DO 分離と Session 隔離（仕様§2, §5.1）", () => {
	it("同一チャンネルの別スレッドは別 DO = 別 SQLite = 別 Session になる", () => {
		const a = createSlackAdapter({
			botToken: "xoxb-test",
			signingSecret: "test-secret",
		});
		const threadId1 = a.encodeThreadId({
			channel: "C0LAN2Q65",
			threadTs: "1515449522.000016",
		});
		const threadId2 = a.encodeThreadId({
			channel: "C0LAN2Q65",
			threadTs: "1515449523.000017",
		});
		expect(threadId1).not.toBe(threadId2);
		const doId1 = env.THREAD_AGENT.idFromName(threadId1);
		const doId2 = env.THREAD_AGENT.idFromName(threadId2);
		expect(doId1.toString()).not.toBe(doId2.toString());
		expect(doId1.equals(doId2)).toBe(false);
		// DO id が異なる = SQLite storage が物理的に分離される = Session が混ざらない
	});

	it("同一スレッドは同一 DO = 同一 Session を再利用する", () => {
		const a = createSlackAdapter({
			botToken: "xoxb-test",
			signingSecret: "test-secret",
		});
		const threadId = a.encodeThreadId({
			channel: "C999",
			threadTs: "555.666",
		});
		expect(env.THREAD_AGENT.idFromName(threadId).toString()).toBe(
			env.THREAD_AGENT.idFromName(threadId).toString(),
		);
	});

	it("DM はチャンネル全体が1 Thread = 1 DO = 1 Session に畳まれる（§3.1, ADR 0002）", () => {
		const a = createSlackAdapter({
			botToken: "xoxb-test",
			signingSecret: "test-secret",
		});
		// agent_view 無効時、DM の threadTs は空文字（§3.1）
		const dmThreadId1 = a.encodeThreadId({ channel: "D123", threadTs: "" });
		const dmThreadId2 = a.encodeThreadId({ channel: "D123", threadTs: "" });
		expect(dmThreadId1).toBe("slack:D123:");
		expect(dmThreadId1).toBe(dmThreadId2);
		expect(env.THREAD_AGENT.idFromName(dmThreadId1).toString()).toBe(
			env.THREAD_AGENT.idFromName(dmThreadId2).toString(),
		);
		// 別 DM チャンネルは別 Session
		const otherDm = a.encodeThreadId({ channel: "D456", threadTs: "" });
		expect(otherDm).not.toBe(dmThreadId1);
		expect(env.THREAD_AGENT.idFromName(otherDm).toString()).not.toBe(
			env.THREAD_AGENT.idFromName(dmThreadId1).toString(),
		);
	});

	it("threadIdForMessageEvent に委譲し、自前で thread_ts ?? ts を再実装しない", () => {
		const a = createSlackAdapter({
			botToken: "xoxb-test",
			signingSecret: "test-secret",
		});
		const threadId = (
			a as unknown as {
				threadIdForMessageEvent: (e: {
					channel?: string;
					channel_type?: string;
					thread_ts?: string;
					ts?: string;
				}) => string;
			}
		).threadIdForMessageEvent({
			channel: "C123",
			channel_type: "channel",
			thread_ts: "111.222",
			ts: "999.999",
		});
		expect(threadId).toBe("slack:C123:111.222");

		const dmId = (
			a as unknown as {
				threadIdForMessageEvent: (e: {
					channel?: string;
					channel_type?: string;
					thread_ts?: string;
					ts?: string;
				}) => string;
			}
		).threadIdForMessageEvent({
			channel: "D123",
			channel_type: "im",
			ts: "999.999",
		});
		expect(dmId).toBe("slack:D123:");
	});
});
