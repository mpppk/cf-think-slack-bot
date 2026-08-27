import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// バインディング・compatibility_date・DO クラスは wrangler.jsonc から読む。
			// ここへ書き写すと「wrangler 側だけ変えたのにテストは旧設定のまま緑」に
			// なりうるので、設定の正は1つに保つ。
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					// テスト用の signing secret。**実物ではなく、検証ロジックに与える
					// ただの入力**。検証ロジックの正しさはここで網羅し、デプロイ済み環境に
					// 正しい secret が配られているかは scripts/smoke.sh が見る(ADR 0025)。
					SLACK_SIGNING_SECRET: "test-signing-secret",
				},
			},
		}),
	],
	test: {
		// ADR 0022: テストは workerd 実環境で走らせる。ファイル名は *.workers.test.ts に
		// 固定する。規約外の *.test.ts が黙って実行対象から漏れる
		// (=「書いたのに走っていない」に気付けない)ことは
		// `bun run check:conventions` が防ぐ。
		include: ["src/**/*.workers.test.ts"],
	},
});
