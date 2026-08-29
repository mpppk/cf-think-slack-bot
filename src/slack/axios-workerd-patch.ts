import axios from "axios";

/**
 * `@slack/web-api` を workerd 上で動かすための設定。
 *
 * ## 何が起きるか
 *
 * `@chat-adapter/slack` は `@slack/web-api` を、`@slack/web-api` は axios を使って
 * Slack Web API を呼ぶ。axios の fetch アダプタは `cache: "default"` をハードコード
 * している（`node_modules/axios/lib/adapters/fetch.js` の `DEFAULT_REQUEST_OPTIONS`）。
 *
 * ところが Cloudflare Workers が受け付ける `cache` は `no-store` と `no-cache` だけで、
 * それ以外を渡すと `TypeError: Unsupported cache mode: default` を投げる。
 * 結果、Slack API 呼び出しが必ず失敗する。
 *
 * さらに悪いことに `WebClient` はこれを**一時的な通信失敗**として扱いリトライを
 * 繰り返すため、例外が表に出ないまま処理がハングする。preview では
 * chat-sdk の初期化がここで止まり、bot がメンションに無反応になっていた。
 *
 * ## なぜこれで直るか
 *
 * 同アダプタは既定値を「そのキーが `undefined` のときだけ」入れる実装なので、
 * axios の `fetchOptions` で `cache` を明示すれば上書きできる。
 * `WebClient` は `axios.create()` でインスタンスを作る＝生成時に `axios.defaults` を
 * 継承するため、**アダプタが作られる前に**この関数を呼んでおく必要がある。
 *
 * `no-store` を選ぶのは、Slack API のレスポンスをキャッシュさせないため。
 *
 * ## 補足
 *
 * Cloudflare 公式の Slack agent サンプルは `@slack/web-api` を使わず素の `fetch` で
 * Slack Web API を叩いており、この問題自体を回避している。こちらは adapter への
 * 委譲（ADR 0003 / ADR 0021）を維持したまま同じ状態に持ち込むための最小の対処。
 */
export function installAxiosWorkerdPatch(): void {
	axios.defaults.fetchOptions = {
		...(axios.defaults.fetchOptions ?? {}),
		cache: "no-store",
	};
}
