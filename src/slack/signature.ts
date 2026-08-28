// Slack Webhook の署名検証。
//
// **これは Chat SDK adapter が入るまでの暫定実装**。ADR 0003 の通り、実装が入ると
// 検証は `@chat-adapter/slack`(`verifyWebhook: false` で adapter 側が signingSecret を
// 使う)に移り、このモジュールは削除する。
//
// 一方で **`src/index.workers.test.ts` と `scripts/smoke.sh` が固定している外形の契約
// (署名が無い/壊れている → 401、正しい署名の `url_verification` → 200 + challenge の
// エコー)は adapter に移っても残す**。これは実装ではなく Slack と我々の間の契約で、
// デプロイ済み環境の signing secret が実際に効いているかを外から見る唯一の手段でもある
// (ADR 0025)。
//
// 検証ロジックの網羅(改竄・期限切れ・ヘッダ欠落)はこのファイルのテストが持ち、実 secret は
// 要らない。実 secret が正しく配られているかはスモークが見る。責務を混ぜないこと。

const SIGNATURE_VERSION = "v0";

/**
 * 署名対象のタイムスタンプの許容ずれ(秒)。Slack の推奨は5分。
 * リプレイ攻撃の窓をこの幅に閉じる。
 */
export const MAX_TIMESTAMP_SKEW_SECONDS = 60 * 5;

/**
 * Slack と同じ方式で署名を作る。検証側とテスト側で式が食い違わないよう、
 * 生成はこの1関数に集約する。
 */
export async function createSlackSignature(
	signingSecret: string,
	timestamp: number,
	body: string,
): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(signingSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${SIGNATURE_VERSION}:${timestamp}:${body}`),
	);
	const hex = Array.from(new Uint8Array(mac), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `${SIGNATURE_VERSION}=${hex}`;
}

export type VerifySlackSignatureParams = {
	signingSecret: string;
	/** `X-Slack-Request-Timestamp` ヘッダ。欠落時は null を渡す */
	timestamp: string | null;
	/** `X-Slack-Signature` ヘッダ。欠落時は null を渡す */
	signature: string | null;
	/** 生のリクエストボディ(パース前の文字列) */
	body: string;
	/** 検証時刻(epoch 秒)。テストから固定するために切り出してある */
	nowSeconds?: number;
};

export async function verifySlackSignature({
	signingSecret,
	timestamp,
	signature,
	body,
	nowSeconds = Math.floor(Date.now() / 1000),
}: VerifySlackSignatureParams): Promise<boolean> {
	if (!signingSecret || !timestamp || !signature) return false;

	const sentAt = Number(timestamp);
	if (!Number.isInteger(sentAt)) return false;
	if (Math.abs(nowSeconds - sentAt) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

	const expected = await createSlackSignature(signingSecret, sentAt, body);
	return timingSafeEqual(expected, signature);
}

/**
 * 長さが違えば即 false、同じなら定数時間で比較する。
 * 単純な `===` だと一致した接頭辞の長さが実行時間に漏れる。
 */
function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	if (left.byteLength !== right.byteLength) return false;
	return crypto.subtle.timingSafeEqual(left, right);
}
