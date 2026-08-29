/**
 * 構造化ログの唯一の入口(ADR 0018: 観測性は Workers Logs のみ)。
 *
 * 経路ごとに `console.log` を直書きしないこと。フィールド名がドリフトすると
 * `wrangler tail --search` / Workers Logs の絞り込みが経路ごとに効かなくなる。
 *
 * Workers Logs はオブジェクトをそのままフィールドとして扱えるので、文字列に
 * 組み立てず素のオブジェクトを渡す。`op` を必ず先頭に付けるのは、
 * `wrangler tail --search slack_webhook` のようにテキスト一致で経路を絞れる
 * ようにするため。
 */
export type LogFields = Record<string, unknown>;

export function logInfo(op: string, msg: string, fields: LogFields = {}): void {
	console.log({ op, msg, ...compact(fields) });
}

export function logError(
	op: string,
	msg: string,
	fields: LogFields = {},
): void {
	console.error({ op, msg, ...compact(fields) });
}

/**
 * 値が無いフィールドは落とす。Slackのイベントは種類ごとに存在するキーが違い
 * (DMには `thread_ts` が無い等)、`undefined` をそのまま載せると
 * 「キーはあるが空」なのか「そもそも来ていない」のか読めなくなる。
 */
function compact(fields: LogFields): LogFields {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	);
}
