import { SlackBot } from "./slack/bot";
import { handleSlackWebhook, SLACK_WEBHOOK_PATH } from "./slack/webhook";

// **このファイルの named export は workerd が「エントリポイント宣言」として検証する**。
// 定数や補助関数を export すると
//   Incorrect type for map entry 'X': the provided value is not of type
//   'function or ExportedHandler'
// でランタイムが起動しなくなる。typecheck・vitest・`wrangler deploy --dry-run` は
// **どれも通ってしまう**ので、共有したい値は別モジュールへ置くこと。
// (実際に踏んだ。`bun run dev` とデプロイ後のスモークだけが検出できる形の壊れ方)
//
// ここから export してよいのは default のハンドラと Durable Object クラスだけ。
export { ThinkMessengerStateAgent } from "@cloudflare/think/messengers";

/**
 * Slack Thread ごとに1つ生成される隔離単位(docs/CONTEXT.md: Thread Agent)。
 * Think Session の永続と agentic loop の実行を担う。
 *
 * SlackBot（Think）を継承し、ChatSDK Thread（slack:{channel}:{thread_ts}）ごとに
 * 1インスタンスが生成されることで Slack Thread -> ChatSDK Thread -> Thread Agent の
 * 1:1:1束縛を実現する。ID組み立ては adapter の threadIdForMessageEvent / encodeThreadId
 * に委譲し、自前で `thread_ts ?? ts` を再実装しない（ADR 0002）。
 * Session を正典とし conversations.replies で再構築しない（ADR 0001）。
 */
export class ThreadAgent extends SlackBot {}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		// デプロイ済み環境をスモークで叩くためのエンドポイント(scripts/smoke.sh)。
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ ok: true, environment: env.ENVIRONMENT });
		}

		if (request.method === "POST" && url.pathname === SLACK_WEBHOOK_PATH) {
			return handleSlackWebhook(request, env, ctx);
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
