import { createSlackAdapter } from "@chat-adapter/slack";
import { Think } from "@cloudflare/think";
import { chatSdkMessenger } from "@cloudflare/think/messengers";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

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
	override getModel() {
		return createOpenRouter({ apiKey: this.env.OPENROUTER_API_KEY ?? "" })(
			"z-ai/glm-5.3-flash",
		);
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
