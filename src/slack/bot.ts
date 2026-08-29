import { createSlackAdapter } from "@chat-adapter/slack";
import { Think } from "@cloudflare/think";
import { chatSdkMessenger } from "@cloudflare/think/messengers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createTavilyTools } from "../tools/tavily";

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
	 * Think の fetch ツール（createFetchTools）を有効化（ADR 0017）。
	 * public な fetch_url として登録され、allowlist に一致する https/http URL を
	 * GET で取得できる。private/local アドレスは isBlockedHost でブロックされる。
	 * fetch はユーザーが貼った URL を要約する用途で使う。
	 */
	override fetchTools = {
		allowlist: ["https://**", "http://**"],
	};

	override getModel() {
		return createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY ?? "" })(
			"z-ai/glm-5.3-flash",
		);
	}

	override getTools() {
		return createTavilyTools({ apiKey: this.env.TAVILY_API_KEY });
	}

	override getMessengers() {
		const adapter = createSlackAdapter({
			botToken: this.env.SLACK_BOT_TOKEN ?? "",
			signingSecret:
				this.env.SLACK_SIGNING_SECRET ?? "missing-placeholder-secret",
		});

		return {
			slack: chatSdkMessenger({
				adapter,
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
}
