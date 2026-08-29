/**
 * 生成失敗時の通知をallowlist方式で分類する（ADR 0009, 仕様§3.8）。
 *
 * - 表示するのはこちらで定義した安定した分類とHTTP statusだけ
 * - 上流の生のエラーメッセージはスレッドに出さず、Workers Logsへ
 * - 通知文例: 「生成に失敗しました（rate_limited / HTTP 429）。少し待って同じスレッドで再送してください。」
 *
 * このモジュールは純粋関数だけを持つ。Slack投稿やログ出力は呼び出し側で行う。
 */

export const FAILURE_CLASSIFICATIONS = [
	"rate_limited",
	"context_overflow",
	"bad_request",
	"unauthorized",
	"forbidden",
	"not_found",
	"upstream_error",
	"unknown",
] as const;

export type FailureClassification = (typeof FAILURE_CLASSIFICATIONS)[number];

/**
 * HTTP statusから分類を決める。allowlistに無いstatusはunknownへ倒すのではなく、
 * 安定した分類へマッピングする。4xxはリクエスト内容をエコーバックしうるため
 * 生メッセージを出さない（ADR 0009）。
 */
function classificationFromStatus(status: number): FailureClassification {
	if (status === 429) {
		return "rate_limited";
	}
	if (status === 400) {
		return "bad_request";
	}
	if (status === 401) {
		return "unauthorized";
	}
	if (status === 403) {
		return "forbidden";
	}
	if (status === 404) {
		return "not_found";
	}
	if (status >= 500 && status <= 599) {
		return "upstream_error";
	}
	if (status >= 400 && status <= 499) {
		return "bad_request";
	}
	return "unknown";
}

/**
 * エラーから HTTP status を抽出する。
 *
 * - APICallError（ai-sdk）の statusCode
 * - fetch Response の status
 * - error.cause の再帰
 * - plain object の status / statusCode
 */
export function extractHttpStatus(error: unknown): number | null {
	if (error === null || error === undefined) {
		return null;
	}
	if (typeof error === "number" && Number.isInteger(error)) {
		if (error >= 100 && error <= 599) {
			return error;
		}
		return null;
	}
	if (typeof error !== "object") {
		return null;
	}
	const obj = error as Record<string, unknown>;

	// APICallError など
	if (typeof obj.statusCode === "number" && Number.isInteger(obj.statusCode)) {
		return obj.statusCode;
	}
	if (typeof obj.status === "number" && Number.isInteger(obj.status)) {
		return obj.status;
	}
	if (
		typeof obj.status_code === "number" &&
		Number.isInteger(obj.status_code)
	) {
		return obj.status_code;
	}
	if (
		typeof obj.responseStatus === "number" &&
		Number.isInteger(obj.responseStatus)
	) {
		return obj.responseStatus;
	}
	// cause の再帰（Error.cause は es2022）
	if ("cause" in obj && obj.cause !== undefined && obj.cause !== null) {
		const fromCause = extractHttpStatus(obj.cause);
		if (fromCause !== null) {
			return fromCause;
		}
	}
	// response オブジェクトを持つ場合
	if (obj.response !== null && typeof obj.response === "object") {
		const fromResponse = extractHttpStatus(obj.response);
		if (fromResponse !== null) {
			return fromResponse;
		}
	}
	// data に status が入っている場合（OpenRouterなど）
	if (obj.data !== null && typeof obj.data === "object") {
		const fromData = extractHttpStatus(obj.data);
		if (fromData !== null) {
			return fromData;
		}
	}
	return null;
}

const CONTEXT_OVERFLOW_PATTERNS =
	/prompt is too long|context length|context_length_exceeded|maximum context|input is too long|too many tokens/i;

function isContextOverflowMessage(message: string): boolean {
	return CONTEXT_OVERFLOW_PATTERNS.test(message);
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	if (
		typeof error === "object" &&
		error !== null &&
		"message" in error &&
		typeof (error as Record<string, unknown>).message === "string"
	) {
		return (error as Record<string, unknown>).message as string;
	}
	try {
		return String(error);
	} catch {
		return "";
	}
}

/**
 * エラーをallowlist分類とHTTP statusへ正規化する。
 *
 * - 生のエラーメッセージは分類の判定材料にのみ使い、返値はallowlistのみ
 * - statusが取れない場合はnull
 * - context_overflow は status があっても優先（LLMが返すプロンプト長エラーは
 *   400で返ることがあり、bad_request より具体的な分類を優先する）
 */
export function classifyFailure(error: unknown): {
	classification: FailureClassification;
	httpStatus: number | null;
} {
	const message = getErrorMessage(error);
	if (isContextOverflowMessage(message)) {
		const status = extractHttpStatus(error);
		// context_overflow のときは HTTP 400 が付いていても overflow を優先
		return { classification: "context_overflow", httpStatus: status ?? 400 };
	}

	const status = extractHttpStatus(error);
	if (status !== null) {
		return {
			classification: classificationFromStatus(status),
			httpStatus: status,
		};
	}

	// statusが無いがメッセージから rate limit を検出できる場合は rate_limited
	if (/rate.?limit|429|too many requests/i.test(message)) {
		return { classification: "rate_limited", httpStatus: 429 };
	}

	return { classification: "unknown", httpStatus: null };
}

/**
 * 分類とHTTP statusからスレッドへ投稿する文面を作る。
 *
 * 生のエラーメッセージは含めない。statusがnullのときは "unknown" と表示する。
 */
export function formatFailureNotice(
	classification: FailureClassification,
	httpStatus: number | null,
): string {
	const statusText = httpStatus === null ? "unknown" : String(httpStatus);
	return `生成に失敗しました（${classification} / HTTP ${statusText}）。少し待って同じスレッドで再送してください。`;
}

/**
 * エラーから直接通知文を作るヘルパ。
 */
export function createFailureNotice(error: unknown): string {
	const { classification, httpStatus } = classifyFailure(error);
	return formatFailureNotice(classification, httpStatus);
}
