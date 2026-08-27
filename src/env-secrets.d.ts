// `wrangler secret` / `.dev.vars` で渡すシークレットの型宣言。**シークレットの宣言は
// このファイルだけに置く**。
//
// `wrangler types` は wrangler.jsonc の vars に加えて**ローカルの `.dev.vars` も型に
// 取り込む**ため、素で実行すると開発者の手元の設定次第で worker-configuration.d.ts に
// シークレットが必須 string として焼き込まれ、ここでの optional 宣言と衝突する
// (skipLibCheck で黙殺される)。生成結果が環境依存で揺れると
// `if (!env.SLACK_SIGNING_SECRET)` のような未設定チェックが「型上は常に truthy」に
// 見える環境と見えない環境が併存し、防御コードの要否判断を誤る。
//
// そのため package.json の cf-typegen は `--env-file=/dev/null` で `.dev.vars` を
// 読ませない。シークレットは必ず未設定でありうるので、ここでは全て optional にする。
//
// ここに名前を足したら `.dev.vars.example` と CI のシークレット同期
// (.github/workflows/ci.yml) にも足すこと。3者のズレは
// `bun run check:conventions` が落とす(ADR 0025)。
declare namespace Cloudflare {
	interface Env {
		// Slack App の Bot User OAuth Token (`xoxb-`)。preview / production で
		// 別の App のものを設定する(ADR 0020)。画像添付を読むには App 側に
		// `files:read` が要る(README)。
		SLACK_BOT_TOKEN?: string;
		// Slack Webhook の署名検証に使う Signing Secret。App ごとに1つで、
		// 用途別の追加発行はできない。preview の値は「preview App のもの」であり
		// production の bot にはなりすませないため、CI のスモークに渡してよい
		// (ADR 0025)。
		SLACK_SIGNING_SECRET?: string;
		// LLM 推論(ADR 0004)。コスト上限は OpenRouter アカウント側で掛ける。
		OPENROUTER_API_KEY?: string;
		// Web 検索ツール(ADR 0017)。
		TAVILY_API_KEY?: string;
	}
}

// 生成される `worker-configuration.d.ts` は `Cloudflare.Env` と グローバルの `Env` を
// 別々に宣言する。上の宣言は前者にだけ載るので、両者が食い違わないよう
// グローバル側にも継承させる(`import { env } from "cloudflare:workers"` は前者、
// `ExportedHandler<Env>` は後者を使う)。
interface Env extends Cloudflare.Env {}
