/**
 * workerd が受け付けない `cache` 指定を落として `Request` / `fetch` を通す。
 *
 * ## 何が起きるか
 *
 * `@chat-adapter/slack` は `@slack/web-api` を、`@slack/web-api` は axios を使って
 * Slack Web API を呼ぶ。axios の fetch アダプタは `cache: "default"` を既定値として
 * 持つ（`node_modules/axios/lib/adapters/fetch.js` の `DEFAULT_REQUEST_OPTIONS`）。
 *
 * Cloudflare Workers が受け付ける `cache` は `no-store` と `no-cache` だけで、
 * それ以外を渡すと `TypeError: Unsupported cache mode: default` を投げる。
 * しかも `WebClient` はこれを**一時的な通信失敗**として扱いリトライを繰り返すため、
 * 例外が表に出ないまま処理がハングする。preview では chat-sdk の初期化がここで
 * 止まり、bot がメンションに無反応になっていた。
 *
 * ## なぜ Request も差し替えるのか
 *
 * axios は `new Request(url, resolvedOptions)` を組んでから fetch へ渡す
 * （同ファイルの `request = isRequestSupported && new Request(url, resolvedOptions)`）。
 * つまり**例外は fetch ではなく Request のコンストラクタで起きる**ので、
 * `fetch` だけを差し替えても素通りしてしまう。両方に当てる必要がある。
 *
 * ## なぜ axios の設定で済ませないのか
 *
 * axios は `fetchOptions` で `cache` を上書きできる作りになっている
 * （既定値は「キーが undefined のときだけ」入る）。しかし axios は CJS と ESM の
 * 2ビルドを持ち、`@slack/web-api` は `require("axios")` で CJS 版、こちらの
 * `import axios` は ESM 版を掴むため**別インスタンス**になり、`axios.defaults` を
 * 触っても Slack 側には届かない（実測で確認済み）。グローバルを差し替える方が確実。
 *
 * ## 影響範囲
 *
 * 落とすのは workerd が**どのみち例外にする値だけ**で、`no-store` / `no-cache` と
 * 未指定はそのまま通す。したがって挙動が変わるのは「今まで必ず失敗していた呼び出し」
 * に限られる。
 *
 * なお Cloudflare 公式の Slack agent サンプルは `@slack/web-api` を使わず素の `fetch`
 * で Slack Web API を叩いており、この問題自体を踏まない。こちらは adapter への委譲
 * （ADR 0003 / ADR 0021）を維持したまま同じ状態に持ち込むための対処。
 */

/** workerd が受け付ける cache 値。これ以外は Request 構築時に例外になる。 */
const SUPPORTED_CACHE_MODES = new Set<string>(["no-store", "no-cache"]);

let installed = false;

/** `init.cache` が workerd で通らない値なら、そのキーを落とした init を返す。 */
function stripUnsupportedCache<T extends RequestInit | undefined>(init: T): T {
	if (!init || typeof init !== "object" || !("cache" in init)) {
		return init;
	}
	const cache = init.cache;
	if (cache === undefined || SUPPORTED_CACHE_MODES.has(cache)) {
		return init;
	}
	const { cache: _unsupported, ...rest } = init;
	return rest as T;
}

/**
 * **呼ぶ順番が重要。** axios はアダプタ生成時に `globalThis.Request` を
 * クロージャへ捕獲し（CJSビルドの `const { fetch: envFetch, Request, Response } = env;`）、
 * 以降の `new Request(...)` はその参照を使う。ESM では import が本体より先に
 * 評価されるため、`@chat-adapter/slack` を import しているモジュールの本体で
 * これを呼んでも手遅れになる。
 *
 * そのためこのモジュールは**読み込まれた時点で自分で適用する**。
 * エントリ（`src/index.ts`）で、axios を引き込む import より前に
 * `import "./slack/workerd-cache-patch";` として副作用込みで読むこと。
 */
export function installWorkerdCachePatch(): void {
	if (installed) {
		return;
	}
	installed = true;

	const OriginalRequest = globalThis.Request;
	class PatchedRequest extends OriginalRequest {
		constructor(input: RequestInfo | URL, init?: RequestInit) {
			super(input, stripUnsupportedCache(init));
		}
	}
	globalThis.Request = PatchedRequest as unknown as typeof Request;

	// Request を経由しない `fetch(url, options)` の経路も塞いでおく。
	const originalFetch = globalThis.fetch;
	globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
		originalFetch(input, stripUnsupportedCache(init))) as typeof fetch;
}

// このモジュールが読み込まれた時点で適用する。axios がアダプタ生成時に
// globalThis.Request を捕獲するため、@chat-adapter/slack の import より前に
// 評価される必要がある（src/index.ts の先頭で副作用 import している）。
installWorkerdCachePatch();
