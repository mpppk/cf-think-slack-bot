import { DurableObject } from "cloudflare:workers";
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

/**
 * Slack Thread ごとに1つ生成される隔離単位(docs/CONTEXT.md: Thread Agent)。
 * Think Session の永続と agentic loop の実行を担う。
 *
 * **中身はこれから**。ここに置いてあるのは、CI(workerd テスト・`wrangler deploy
 * --dry-run`)とデプロイ経路を実際に動かすための最小の骨格で、実装は後続のPRで入る。
 */
export class ThreadAgent extends DurableObject<Env> {}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		// デプロイ済み環境をスモークで叩くためのエンドポイント(scripts/smoke.sh)。
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({ ok: true, environment: env.ENVIRONMENT });
		}

		if (request.method === "POST" && url.pathname === SLACK_WEBHOOK_PATH) {
			return handleSlackWebhook(request, env);
		}

		return new Response("Not Found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
