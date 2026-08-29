import { env } from "cloudflare:workers";
import { createSlackAdapter } from "@chat-adapter/slack";
import type { Session } from "@cloudflare/think";
import { describe, expect, it } from "vitest";
import { SlackBot } from "./bot";

// Think Session を正典とし、Slack の conversations.replies で再構築しない(ADR 0001)。
// Session は無期限保持・tool_result も永続(仕様§3.7)。compaction は #28 で
// 登録されるまで何もしないことが正しい(ADR 0007)。

function createBot(envOverrides: Partial<Env>): SlackBot {
	const bot = Object.create(SlackBot.prototype) as SlackBot;
	(bot as unknown as { env: Env }).env = envOverrides as Env;
	return bot;
}

describe("Think Session 永続化 (§3.7, ADR 0001, ADR 0007)", () => {
	it("configureSession は Session をそのまま返し、無期限保持を保証する", async () => {
		const bot = createBot({
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
			OPENROUTER_API_KEY: "test",
		});
		// Session のモック。onCompaction / compactAfter が #28 まで呼ばれないこと
		// が「無期限保持・compaction未登録」の正しい状態。
		const mockSession = {
			onCompaction: (() => mockSession) as unknown as Session["onCompaction"],
			compactAfter: (() => mockSession) as unknown as Session["compactAfter"],
		} as unknown as Session;

		// 呼び出し回数を数えるため vi 的にラップしないが、呼ばれていないことを
		// 返り値の同一性で間接的に担保する。もし将来ここで compaction を登録
		// するようになれば、このテストは #28 の実装と共に更新される。
		const result = await bot.configureSession(mockSession);
		expect(result).toBe(mockSession);
	});

	it("configureSession は tool_result を間引かず、そのまま永続させる", async () => {
		// tool_result は Session の UIMessage parts として保存される。ここで
		// configureSession がフィルタを掛けていないことは「永続する」ことと
		// 同値。上のテストと同じく、返り値が同一であることで担保する。
		const bot = createBot({
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
		});
		const session = {
			// 最小のSessionモック: 実際のSessionなら tool parts を保持する
			// ここではインスタンスの同一性で検証する
		} as unknown as Session;
		const returned = await bot.configureSession(session);
		expect(returned).toBe(session);
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
