import { createSlackAdapter } from "@chat-adapter/slack";
import type {
	ChatErrorContext,
	Session,
	TurnConfig,
	TurnContext,
} from "@cloudflare/think";
import { defaultContextOverflowClassifier, Think } from "@cloudflare/think";
import { chatSdkMessenger } from "@cloudflare/think/messengers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createCompactFunction } from "agents/experimental/memory/utils";
import { generateText } from "ai";
import { logError } from "../observability/log";
import { createTavilyTools } from "../tools/tavily";
import {
	type AttachmentInput,
	filterAttachments,
	toDataUrl,
} from "./attachment";
import { classifyFailure, formatFailureNotice } from "./failure-notice";
import { fetchSlackFile, SlackFileMissingScopeError } from "./fetch-slack-file";
import {
	installMessengerPatch,
	setPendingFailureNotice,
} from "./messenger-patch";
import { installWorkerdCachePatch } from "./workerd-cache-patch";

// 生成失敗時の投稿を allowlist へ差し替えるパッチを workerd 起動時に当てる（ADR 0009）
installMessengerPatch();

// axios(@slack/web-api 経由)が cache: "default" を付けるせいで Slack API 呼び出しが
// workerd で必ず失敗する。adapter が作られる前にグローバルを差し替えておく。
installWorkerdCachePatch();

/**
 * compaction の閾値。
 *
 * z-ai/glm-5.3-flash の context_length は 1,310,720（ADR 0004、OpenRouter models API）。
 * top_provider の実効上限は 1,048,576 だが、Session のトークン見積もりは heuristic
 *（chars/4 と words*1.3 の max）で誤差があり、tool_result（tavily/fetch）が
 * 大きく膨らむため、余裕を持って閾値を設定する。
 *
 * - compactAfter: 間のターンで走る。通常の履歴蓄積で溢れる前に要約する。
 *   100,000 は 1.31M の約7.6%、1M の約9.5%。保守的に早めに要約し、長いスレッドでも
 *   context_overflow を未然に防ぐ。モデル差し替え時は context_length に合わせて見直す（ADR 0007）。
 * - proactive.maxInputTokens: ターン内のステップループで走る。モデルが報告する
 *   usage.inputTokens が headroom(0.9) を超えたら要約し、provider の 400 を未然に防ぐ。
 *   1,000,000 は 1.31M の約76%、1M の約95% に相当。
 */
export const COMPACTION_THRESHOLD_TOKENS = 100_000;
export const COMPACTION_PROACTIVE_MAX_INPUT_TOKENS = 1_000_000;

/**
 * Slack 向けの Think エージェント。
 *
 * - LLM は OpenRouter の z-ai/glm-5.3-flash を直書き(ADR 0004, vars化しない)
 * - Messenger は @chat-adapter/slack + chatSdkMessenger で接続(ADR 0003)
 * - respondTo は仕様§3.1の通り direct-message / mention / subscribed-thread
 * - ID は自前で組み立てず adapter の threadIdForMessageEvent / encodeThreadId に委譲(ADR 0002)
 * - Session を正典とし Slack の conversations.replies で再構築しない(ADR 0001)
 */
export class SlackBot extends Think<Env> {
	/**
	 * context window 溢れの自動復旧（仕様§3.7, ADR 0007）。
	 *
	 * - reactive: context_overflow で失敗したターンを compact() してリトライする。
	 *   classifyChatError が "context_overflow" を返したときのみ発動する。
	 * - proactive: ターン内のステップ間で usage.inputTokens が閾値を超えたら
	 *   事前に compact() し、provider の 400 を未然に防ぐ。
	 *
	 * どちらも Session の compaction（onCompaction/compactAfter）に依存する。
	 * compaction 未登録なら shortened=false で context_overflow として終了する。
	 */
	override contextOverflow = {
		reactive: true,
		proactive: { maxInputTokens: COMPACTION_PROACTIVE_MAX_INPUT_TOKENS },
	} as const;

	override classifyChatError = defaultContextOverflowClassifier;

	/**
	 * Think の fetch ツール（createFetchTools）を有効化（ADR 0017）。
	 * public な fetch_url として登録され、allowlist に一致する https/http URL を
	 * GET で取得できる。private/local アドレスは isBlockedHost でブロックされる。
	 * fetch はユーザーが貼った URL を要約する用途で使う。
	 */
	override fetchTools = {
		allowlist: ["https://**", "http://**"],
	};

	/**
	 * Think Session の永続化設定（仕様§3.7, ADR 0001, ADR 0007）。
	 *
	 * Session は DO SQLite に無期限保持され、tool_result も永続する。
	 * 要約は addCompaction() の overlay として保存され、元の行はSQLiteに残るため
	 * session.search()（FTS5）からは引き続き参照できるが、モデルへ渡る履歴からは隠れる。
	 * Think にデフォルトの compaction は無いため onCompaction() + compactAfter() を
	 * 明示的に登録する。登録しないと長いスレッドは context_overflow で失敗する。
	 *
	 * 閾値は z-ai/glm-5.3-flash の context_length 1,310,720（ADR 0004）に合わせて
	 * COMPACTION_THRESHOLD_TOKENS（100k, 約7.6%）とし、モデル差し替え時は見直す。
	 */
	override configureSession(session: Session): Session {
		return session
			.onCompaction(
				createCompactFunction({
					summarize: (prompt: string) =>
						generateText({ model: this.getModel(), prompt }).then(
							(r: { text: string }) => r.text,
						),
				}),
			)
			.compactAfter(COMPACTION_THRESHOLD_TOKENS);
	}

	override getModel() {
		return createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY ?? "" })(
			"z-ai/glm-5.3-flash",
		);
	}

	override getTools() {
		return createTavilyTools({ apiKey: this.env.TAVILY_API_KEY });
	}

	/**
	 * Slack adapter。`beforeTurn` が `rehydrateAttachment()` を呼ぶために
	 * 同じインスタンスを共有する必要があるので、生成をここに集約して保持する。
	 */
	private slackAdapter?: ReturnType<typeof createSlackAdapter>;

	private getSlackAdapter(): ReturnType<typeof createSlackAdapter> {
		this.slackAdapter ??= createSlackAdapter({
			botToken: this.env.SLACK_BOT_TOKEN ?? "",
			signingSecret:
				this.env.SLACK_SIGNING_SECRET ?? "missing-placeholder-secret",
			// workerd テストでは SLACK_BOT_TOKEN が未設定。botUserId 未指定だと
			// adapter.initialize() が Slack API(auth.test)へネットワークしてハングする
			// (ローカルの vitest は外部への fetch がタイムアウトまでブロックされる)。
			// トークンが無い環境ではダミーを渡して API 呼び出しをスキップする。
			// 本番/preview ではトークンが設定されるため undefined のままにし、実体を
			// 取得させる。app_mention の isMention は event.type で判定されるため
			// ダミーでも配送には影響しない。
			...(this.env.SLACK_BOT_TOKEN ? {} : { botUserId: "U_test_dummy" }),
		});
		return this.slackAdapter;
	}

	override getMessengers() {
		return {
			slack: chatSdkMessenger({
				adapter: this.getSlackAdapter(),
				provider: "slack",
				userName: "cf-think-slack-bot",
				respondTo: ["direct-message", "mention", "subscribed-thread"],
				verifyWebhook: false,
			}),
		};
	}

	override getSystemPrompt() {
		return "あなたは丁寧な口調で応答するアシスタントです。Slackで読めるMarkdownで回答してください。";
	}

	/**
	 * 添付のダウンロード関数を解決する（仕様§3.4, ADR 0021 の例外）。
	 *
	 * **Think は Chat SDK thread ごとに sub-agent を作るため、イベントは
	 * Durable Object をまたいでシリアライズされる。** そのとき `fetch` /
	 * `data` / `raw` はクロージャやバイナリなので**失われ**、`fetchMetadata`
	 * （Slack ならファイルURLとteamId）だけが残る。MessengerAttachment の
	 * 型定義にもそう明記されている。
	 *
	 * 旧実装は adapter の `rehydrateAttachment()` に委譲していたが、
	 * `@chat-adapter/shared` の downloadAttachment() が node:dns / node:https /
	 * node:zlib / node:stream に依存し workerd では原理的に動かない
	 * （NetworkError: Failed to fetch Slack file）ため、素の fetch で自前実装する
	 * （fetch-slack-file.ts）。ただし `fetchMetadata.url` からの復元という筋は保つ。
	 *
	 * 768ab1e の対処（DOホップで fetch が失われる）を維持するため、fetch が無い
	 * 場合は fetchMetadata.url から組み直す。9a96b0f の対処（teamId を落として
	 * 静的 SLACK_BOT_TOKEN へフォールバック）も維持するが、fetch-slack-file が
	 * teamId を使わず静的 token で取得するため、フィルタ自体は不要になっている。
	 * 念のため url の有無だけを見る。
	 *
	 * 直接 `att.fetch` だけを見て諦めると、**同一ターン内でしか画像を読めない**。
	 * 実際それで preview の bot が画像を黙って無視していた。
	 */
	private resolveAttachmentFetch(
		att: AttachmentInput,
	): (() => Promise<ArrayBuffer | Buffer | Uint8Array>) | undefined {
		const direct =
			(att as { fetch?: () => Promise<ArrayBuffer> }).fetch ??
			(att as { fetchData?: () => Promise<Buffer | ArrayBuffer> }).fetchData;
		if (direct) {
			return direct;
		}

		// シリアライズを跨いだ後。fetchMetadata から取得手段を組み直す。
		const meta = (att as { fetchMetadata?: Record<string, string> })
			.fetchMetadata;
		const urlFromMeta = meta?.url;
		// 旧来は teamId / enterpriseId を落として rehydrate していたが、自前実装では
		// teamId を使わず静的 token で取得するため不要。url があればそれで取得する。
		// 単一ワークスペース前提（仕様§4.2）は維持する。
		const url = urlFromMeta ?? (att as { url?: string }).url;
		if (!url) {
			logError("slack_attachment_rehydrate_failed", "添付の復元に失敗した", {
				error: "missing url in attachment",
			});
			return undefined;
		}

		// 自前の fetch 実装を返す。bot token は Env から取る。
		// workerd テストでは env が無い場合もあるため、そのときは空文字で呼び出し、
		// fetchSlackFile 側でホスト検証が先に走る。
		const token = this.env.SLACK_BOT_TOKEN ?? "";
		return async () => {
			const data = await fetchSlackFile(url, token);
			return data;
		};
	}

	/**
	 * 画像添付の受け取りと上限超過時の通知（仕様§3.4, ADR 0006, ADR 0021 の例外）。
	 *
	 * - jpeg / png / webp、1枚10MB以下、1メッセージ4枚までを Vision でモデルへ渡す
	 * - 非画像・5枚目以降・10MB超は Session に保存せず、日本語1行で通知する
	 * - 取得は attachment.fetch / fetchData が残っていれば委譲し、DOホップで失われた
	 *   場合は fetchMetadata.url から fetchSlackFile（素の fetch）で再取得する。
	 *   Session には fetchMetadata.url を残し、過去ターンの画像は必要時に再取得する
	 *   想定だが、現実装では data URL を Session に保存し、次ターン以降も履歴として
	 *   モデルへ渡る。ユーザーが Slack 上でファイルを削除した際の再取得失敗は許容する（ADR 0006）。
	 * - Slack App に files:read が必須。無いと HTML ログインページが返り
	 *   SlackFileMissingScopeError を投げ、slack_attachment_missing_scope として
	 *   ログに残す（adapter と同じ判定）
	 */
	override async beforeTurn(ctx: TurnContext): Promise<TurnConfig | undefined> {
		const messenger = this.getMessengerContext() as
			| { message?: { attachments?: AttachmentInput[] } }
			| undefined;
		const attachments = messenger?.message?.attachments;
		if (!attachments || attachments.length === 0) {
			return;
		}

		const { accepted, notices } = filterAttachments(attachments);

		// 上限超過は Session に保存せず、スレッドへ1行で通知する
		for (const notice of notices) {
			try {
				await this.deliverNotice(notice);
			} catch {
				// deliverNotice が解決できない場合（web チャンネル等）はログに残すだけ
				logError("slack_attachment_notice_failed", notice);
			}
		}

		if (accepted.length === 0) {
			return;
		}

		// 許可された画像を取得し、Vision 用の file part へ変換する
		const modelFileParts: Array<{
			type: "file";
			data: string;
			mediaType: string;
		}> = [];
		const sessionFileParts: Array<{
			type: "file";
			mediaType: string;
			url: string;
			filename?: string;
		}> = [];

		for (const att of accepted) {
			try {
				const fetchFn = this.resolveAttachmentFetch(att);
				if (!fetchFn) {
					// 黙って捨てると「画像を無視する bot」にしか見えず原因が追えない
					logError(
						"slack_attachment_unfetchable",
						"添付のダウンロード手段を解決できなかった",
						{
							mimeType: att.mediaType ?? att.mimeType,
							hasFetchMetadata: Boolean(
								(att as { fetchMetadata?: unknown }).fetchMetadata,
							),
							hasUrl: Boolean((att as { url?: unknown }).url),
						},
					);
					continue;
				}
				const data = await fetchFn();
				if (!data) {
					continue;
				}
				const mime = (att.mediaType ?? att.mimeType ?? "") as string;
				const dataUrl = toDataUrl(data as ArrayBuffer, mime);
				modelFileParts.push({
					type: "file",
					data: dataUrl,
					mediaType: mime,
				});
				sessionFileParts.push({
					type: "file",
					mediaType: mime,
					url: dataUrl,
					filename: att.name,
				});
			} catch (error) {
				// files:read 無しで HTML が返ると NetworkError 相当を投げる。
				// 汎用エラーと区別できる専用ログとして残す（adapter と同じ判定）。
				if (error instanceof SlackFileMissingScopeError) {
					logError(
						"slack_attachment_missing_scope",
						"files:read scope is missing",
						{
							error: String(error).slice(0, 500),
							mimeType: att.mediaType ?? att.mimeType,
							size: att.size,
						},
					);
				} else {
					logError(
						"slack_attachment_fetch_failed",
						"failed to fetch attachment",
						{
							error: String(error).slice(0, 500),
							mimeType: att.mediaType ?? att.mimeType,
							size: att.size,
						},
					);
				}
			}
		}

		if (modelFileParts.length === 0) {
			return;
		}

		// 現在ターンのモデル入力へ file part を注入する
		const messages = [...ctx.messages];
		let lastUserIdx = -1;
		for (let i = messages.length - 1; i >= 0; i--) {
			if ((messages[i] as { role: string }).role === "user") {
				lastUserIdx = i;
				break;
			}
		}
		if (lastUserIdx === -1) {
			return;
		}
		const last = messages[lastUserIdx] as unknown as {
			role: string;
			content: unknown;
		};
		if (typeof last.content === "string") {
			(last as { content: unknown }).content = [
				{ type: "text", text: last.content },
				...modelFileParts,
			];
		} else if (Array.isArray(last.content)) {
			(last as { content: unknown[] }).content = [
				...(last.content as unknown[]),
				...modelFileParts,
			];
		} else {
			(last as { content: unknown }).content = [...modelFileParts];
		}

		// Session にも保存し、次ターン以降の履歴としてモデルへ渡るようにする。
		// 本来は fetchMetadata.url を保存して再取得する想定だが、現実装では data URL を
		// 保存することで Vision の履歴保持を実現する。ユーザーが Slack 上で削除した場合の
		// 再取得失敗は ADR 0006 で許容されている。
		try {
			const leaf = await this.session.getLatestLeaf();
			if (leaf && leaf.role === "user") {
				const updatedParts = [...leaf.parts];
				for (const p of sessionFileParts) {
					updatedParts.push(p as unknown as (typeof leaf.parts)[number]);
				}
				await this.session.updateMessage({ ...leaf, parts: updatedParts });
			}
		} catch {
			// Session 更新失敗はモデルへの送信を妨げない
		}

		return { messages: messages as TurnContext["messages"] };
	}

	/**
	 * 生成失敗時のハンドリング（仕様§3.8, ADR 0009）。
	 *
	 * - 失敗はスレッドへ通常メッセージ（ephemeralではない）で通知する
	 * - 出すのはallowlistした分類とHTTP statusだけ。上流の生メッセージは出さない
	 * - 詳細は Workers Logs のみに残す（bun run logs）
	 * - dedupe はここに来ない（adapter が弾く）ためサイレントのまま
	 */
	override onChatError(error: unknown, ctx?: ChatErrorContext): unknown {
		const { classification, httpStatus } = classifyFailure(error);
		const notice = formatFailureNotice(classification, httpStatus);

		// 詳細は Logs のみに残す。生の error はスレッドに出さない
		const rawMessage = error instanceof Error ? error.message : String(error);
		const rawStack = error instanceof Error ? error.stack : undefined;
		logError("slack_generation_failure", "generation failed", {
			classification,
			httpStatus,
			stage: ctx?.stage,
			requestId: ctx?.requestId,
			messagesPersisted: ctx?.messagesPersisted,
			// Workers Logs にのみ残す。スレッドへは notice だけ出す
			error: rawMessage.slice(0, 2000),
			stack: rawStack?.slice(0, 2000),
		});

		// messenger 配送の generic な英語文面を allowlist 文面へ置換するため、
		// スレッドIDに紐付けて保留する。ThinkMessengerRuntime の patch が
		// 次の thread.post でこれを consume して投稿する
		const threadId = this.resolveFailureThreadId();
		if (threadId !== undefined) {
			setPendingFailureNotice(threadId, notice);
		} else {
			// thread が解決できない場合（web チャンネル等）は直接 deliverNotice を試みる
			// 失敗してもログに残っているので無視
			void this.deliverNotice(notice).catch(() => {});
		}

		// Think 側の callback へ渡るメッセージも allowlist にする（二重投稿ではなく、
		// patch が generic を置換する際の元ネタとして使われる）
		return new Error(notice);
	}

	/**
	 * onChatError 内で現在のスレッドIDを解決する。Think の activeChannel / messenger
	 * コンテキストから ChatSDK の thread.id を取り出す。
	 */
	private resolveFailureThreadId(): string | undefined {
		const self = this as unknown as {
			activeChannel?: { thread?: string; channelId?: string };
			_activeChannelId?: () => string | undefined;
			_activeMessengerContext?: { thread?: { id?: string } };
			_activeDeliverySurface?: unknown;
			_messengerRuntime?: { chat?: unknown };
		};
		// 1. activeChannel.thread が最も確実（messenger のときは slack:{channel}:{threadTs}）
		if (
			typeof self.activeChannel?.thread === "string" &&
			self.activeChannel.thread.length > 0
		) {
			return self.activeChannel.thread;
		}
		// 2. _activeChannelId() があればそれを使う
		if (typeof self._activeChannelId === "function") {
			try {
				const ch = self._activeChannelId();
				if (typeof ch === "string" && ch.length > 0) {
					// ch は channelId（slack など）の場合と threadId の場合がある。
					// thread を含まない channelId だけでは post 先が解決できないため、
					// thread が無いときは undefined を返す
					if (ch.includes(":")) {
						return ch;
					}
				}
			} catch {
				// ignore
			}
		}
		// 3. messenger コンテキストから
		const mid = self._activeMessengerContext?.thread?.id;
		if (typeof mid === "string" && mid.length > 0) {
			return mid;
		}
		return undefined;
	}
}
