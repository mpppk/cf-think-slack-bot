/**
 * Think の messenger 配送（deliverMessengerReply）の失敗投稿を
 * allowlist方式へ差し替えるパッチ（ADR 0009）。
 *
 * - 既定の `errorResponseText`（"Sorry, I couldn't answer..."）をそのまま出すと
 *   生のエラーを隠せない。error から分類と HTTP status だけを抽出した
 *   日本語の定型文を投稿する。
 * - 詳細は `onChatError` 側で Workers Logs へ出しているため、ここでは投稿のみ担う
 * - dedupe（重複配送）はもともとサイレント。ここで余計な投稿をしないことで
 *   既存のサイレント挙動を壊さない
 *
 * 実装は `ThinkMessengerRuntime.prototype.answer` をラップする。
 * `answer` は `deliverMessengerReply` を呼ぶ唯一の経路で、差し替えることで
 * Workerd 上の全ての Slack 配送にパッチが当たる。
 *
 * `answer` の中で `thread.post` をラップし、generic な英語文面が投稿される
 * 瞬間を allowlist 文面へ置換する。置換に使う文面は `SlackBot.onChatError`
 * が `setPendingFailureNotice` で登録したもの（同じスレッドIDで紐付け）。
 */

import { ThinkMessengerRuntime } from "@cloudflare/think/messengers";
import { classifyFailure, formatFailureNotice } from "./failure-notice";

// スレッドIDごとの保留中の失敗通知。onChatError が書き込み、answer の post ラッパが読み取る。
const pendingByThread = new Map<string, string>();

// 英語の既定文面（chat-sdk-C8BvREXn.js の定数と一致させる）
const DEFAULT_ERROR_TEXT =
	"Sorry, I couldn't answer that right now. Please try again.";
const DEFAULT_EMPTY_TEXT =
	"I couldn't produce a text response. Please try again.";
const DEFAULT_INTERRUPTED_TEXT =
	"Sorry, my reply was interrupted. Please send your message again if you'd like me to retry.";

function isGenericErrorMessage(message: unknown): boolean {
	if (typeof message === "string") {
		return message === DEFAULT_ERROR_TEXT;
	}
	if (
		typeof message === "object" &&
		message !== null &&
		"markdown" in message &&
		typeof (message as Record<string, unknown>).markdown === "string"
	) {
		return (message as Record<string, unknown>).markdown === DEFAULT_ERROR_TEXT;
	}
	return false;
}

/**
 * SlackBot.onChatError から呼ぶ。分類済みの通知文をスレッドIDに紐付けて保留する。
 * 次の `thread.post` で generic が来たらこの文面へ置換する。
 */
export function setPendingFailureNotice(
	threadId: string,
	notice: string,
): void {
	pendingByThread.set(threadId, notice);
}

export function consumePendingFailureNotice(
	threadId: string,
): string | undefined {
	const notice = pendingByThread.get(threadId);
	if (notice !== undefined) {
		pendingByThread.delete(threadId);
	}
	return notice;
}

/**
 * エラーから直接通知文を作り、generic を置換するフォールバック。
 * onChatError が呼ばれなかった経路（まれ）でも生漏れを防ぐ。
 */
function noticeFromError(error: unknown): string {
	const { classification, httpStatus } = classifyFailure(error);
	return formatFailureNotice(classification, httpStatus);
}

/**
 * パッチを当てる。`src/slack/bot.ts` のトップレベルで一度だけ呼ぶこと。
 * 二重適用を防ぐためフラグでガードする。
 */
let patched = false;

export function installMessengerPatch(): void {
	if (patched) {
		return;
	}
	patched = true;

	const proto = (
		ThinkMessengerRuntime as unknown as {
			prototype: {
				answer: (
					definition: unknown,
					event: unknown,
					thread: { id: string; post: (m: unknown) => Promise<unknown> },
					fiber: unknown,
					snapshotEvent: unknown,
					checkpoint: unknown,
				) => Promise<void>;
			};
		}
	).prototype;
	const originalAnswer = proto.answer;

	proto.answer = async function (
		definition: unknown,
		event: unknown,
		thread: {
			id: string;
			post: (m: unknown) => Promise<unknown>;
			startTyping?: () => Promise<void>;
		},
		fiber: unknown,
		snapshotEvent: unknown,
		checkpoint: unknown,
	) {
		// thread.post をラップして generic を allowlist へ置換。Proxy で委譲しつつ post だけ差し替える
		const originalPost = thread.post.bind(thread);
		const wrappedThread = new Proxy(thread, {
			get(target, prop, receiver) {
				if (prop === "post") {
					return async (message: unknown) => {
						if (isGenericErrorMessage(message)) {
							const threadId = (target as { id: string }).id;
							const pending = consumePendingFailureNotice(threadId);
							if (pending !== undefined) {
								return originalPost({ markdown: pending });
							}
							// フォールバック: 直前のエラーが不明でも unknown で投稿（生を出さない）
							const fallback = formatFailureNotice("unknown", null);
							return originalPost({ markdown: fallback });
						}
						return originalPost(message as never);
					};
				}
				const value = Reflect.get(target, prop, receiver);
				if (typeof value === "function") {
					return value.bind(target);
				}
				return value;
			},
		}) as unknown as typeof thread;

		try {
			return await originalAnswer.call(
				this,
				definition,
				event,
				wrappedThread as never,
				fiber,
				snapshotEvent,
				checkpoint,
			);
		} finally {
			// 成功時や dedupe 時は pending が残ることがある。次ターンへ漏れないよう消す。
			const tid = (thread as { id: string }).id;
			pendingByThread.delete(tid);
		}
	};
}

// テスト用: パッチが当たっているか確認
export function isMessengerPatchInstalled(): boolean {
	return patched;
}

// テスト用: 内部の generic 定数を公開
export const __test__ = {
	DEFAULT_ERROR_TEXT,
	DEFAULT_EMPTY_TEXT,
	DEFAULT_INTERRUPTED_TEXT,
	pendingByThread,
	noticeFromError,
};
