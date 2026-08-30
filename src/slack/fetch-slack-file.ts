/**
 * Slack 添付のダウンロードを素の fetch で行う（ADR 0021 の例外）。
 *
 * @chat-adapter/shared の downloadAttachment() は node:dns / node:https / node:zlib /
 * node:stream に依存し workerd では動かない。ここでは fetch だけで同等の保護を持つ:
 *
 * - Slack ホストに限定（SSRF 対策）
 * - リダイレクト先が Slack ホストでなければ Authorization を送らない
 * - サイズ上限（content-length 詐称に備えストリーム読み取り時にも上限）
 * - リダイレクト回数上限
 * - content-type が text/html なら files:read 不足として専用エラー
 */

import { MAX_IMAGE_BYTES } from "./attachment";

// adapter の上限は 25MB だが、このプロダクトの仕様は 10MB（ADR 0006）。
// フェッチ時の上限も仕様に合わせる。filterAttachments で事前に弾いても、
// fetchMetadata からの再取得や content-length 詐称に備えて二重に掛ける。
export const FETCH_LIMIT_BYTES = MAX_IMAGE_BYTES;
export const FETCH_MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 30_000;

// Slack がファイル配信に使うホストの allowlist。サブドメインも許可する。
// origins（token 送出の判定）は別に持つ。ここは SSRF 対策の「任意 URL を取りに
// 行かせない」ための広い allowlist。
export const SLACK_ALLOWED_HOSTS = [
	"slack.com",
	"slack-edge.com",
	"slack-files.com",
	"slack-files-gov.com",
	"slack-gov.com",
] as const;

// adapter の file.ts と同じ 6 origin。token はこの origin でのみ送る。
// https://github.com/.../slack/dist/chunk-7WDLOIRP.js の origins と一致させる。
export const TRUSTED_SLACK_ORIGINS = new Set<string>([
	"https://files.slack.com",
	"https://files.slack-gov.com",
	"https://slack-files.com",
	"https://slack-files-gov.com",
	"https://slack.com",
	"https://slack-gov.com",
]);

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export class SlackFileFetchError extends Error {
	override name = "SlackFileFetchError";
}

export class SlackFileMissingScopeError extends SlackFileFetchError {
	override name = "SlackFileMissingScopeError";
}

export class SlackFileTooLargeError extends SlackFileFetchError {
	override name = "SlackFileTooLargeError";
}

export class SlackFileTooManyRedirectsError extends SlackFileFetchError {
	override name = "SlackFileTooManyRedirectsError";
}

export function isAllowedSlackHost(hostname: string): boolean {
	const lower = hostname.toLowerCase();
	for (const allowed of SLACK_ALLOWED_HOSTS) {
		if (lower === allowed || lower.endsWith(`.${allowed}`)) {
			return true;
		}
	}
	return false;
}

export function isTrustedSlackOrigin(
	urlString: string,
	apiUrl?: string,
): boolean {
	try {
		const origin = new URL(urlString).origin;
		if (TRUSTED_SLACK_ORIGINS.has(origin)) {
			return true;
		}
		if (apiUrl) {
			try {
				if (origin === new URL(apiUrl).origin) {
					return true;
				}
			} catch {
				// ignore malformed apiUrl
			}
		}
		return false;
	} catch {
		return false;
	}
}

function validateSlackUrl(url: URL): void {
	if (url.protocol !== "https:") {
		throw new SlackFileFetchError(
			"Refusing to fetch an untrusted attachment URL",
		);
	}
	if (!isAllowedSlackHost(url.hostname)) {
		throw new SlackFileFetchError(
			"Refusing to fetch an untrusted attachment URL",
		);
	}
}

export type FetchSlackFileOptions = {
	fetchImpl?: typeof fetch;
	limitBytes?: number;
	maxRedirects?: number;
	timeoutMs?: number;
	slackApiUrl?: string;
};

/**
 * Slack のファイル URL からバイナリを取得する。
 *
 * - 取得先は SLACK_ALLOWED_HOSTS に限定する
 * - Authorization は TRUSTED_SLACK_ORIGINS へのホップでのみ送る（リダイレクトで外部へ漏らさない）
 * - redirect は manual で手動追跡し、回数上限を掛ける
 * - content-length とストリーム累積の両方でサイズ上限を掛ける
 * - content-type が text/html なら files:read 不足として SlackFileMissingScopeError を投げる
 */
export async function fetchSlackFile(
	urlString: string,
	token: string,
	options: FetchSlackFileOptions = {},
): Promise<Uint8Array> {
	const limitBytes = options.limitBytes ?? FETCH_LIMIT_BYTES;
	const maxRedirects = options.maxRedirects ?? FETCH_MAX_REDIRECTS;
	const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
	const fetchImpl = options.fetchImpl ?? fetch;
	const slackApiUrl = options.slackApiUrl;

	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		throw new SlackFileFetchError(
			"Refusing to fetch an untrusted attachment URL",
		);
	}
	validateSlackUrl(url);

	for (let hop = 0; hop <= maxRedirects; hop++) {
		const headers: Record<string, string> = {
			"user-agent": "cf-think-slack-bot",
			accept: "*/*",
		};
		// token は信頼できる Slack origin へのホップでのみ送る
		if (token && isTrustedSlackOrigin(url.href, slackApiUrl)) {
			headers.authorization = `Bearer ${token}`;
		}

		const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;

		let response: Response;
		try {
			response = await fetchImpl(url.href, {
				method: "GET",
				headers,
				redirect: "manual",
				signal,
			});
		} catch (error) {
			if (signal?.aborted) {
				throw new SlackFileFetchError("Timed out fetching the attachment");
			}
			throw new SlackFileFetchError(
				`Failed to fetch Slack file: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		// リダイレクトは手動で追う
		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			// body を消費しないと workerd でリークする可能性があるため破棄
			try {
				await response.arrayBuffer().catch(() => {});
			} catch {
				// ignore
			}
			if (!location) {
				throw new SlackFileFetchError("Attachment redirect has no location");
			}
			if (hop === maxRedirects) {
				throw new SlackFileTooManyRedirectsError(
					"Too many attachment redirects",
				);
			}
			let nextUrl: URL;
			try {
				nextUrl = new URL(location, url.href);
			} catch {
				throw new SlackFileFetchError(
					"Refusing to fetch an untrusted attachment URL",
				);
			}
			validateSlackUrl(nextUrl);
			url = nextUrl;
			continue;
		}

		if (response.status < 200 || response.status >= 300) {
			try {
				await response.arrayBuffer().catch(() => {});
			} catch {
				// ignore
			}
			throw new SlackFileFetchError(
				`Failed to fetch Slack file: ${response.status} ${response.statusText ?? ""}`.trim(),
			);
		}

		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.toLowerCase().includes("text/html")) {
			try {
				await response.arrayBuffer().catch(() => {});
			} catch {
				// ignore
			}
			throw new SlackFileMissingScopeError(
				`Failed to download file from Slack: received HTML login page instead of file data. Ensure your Slack app has the "files:read" OAuth scope.`,
			);
		}

		// 事前の content-length チェック（詐称されうるのでストリームでも再チェックする）
		const declaredHeader = response.headers.get("content-length");
		if (declaredHeader !== null) {
			const declared = Number(declaredHeader);
			if (Number.isFinite(declared) && declared > limitBytes) {
				try {
					await response.arrayBuffer().catch(() => {});
				} catch {
					// ignore
				}
				throw new SlackFileTooLargeError(
					"Attachment exceeds the download limit",
				);
			}
		}

		// ストリームを読みながら上限を掛ける（content-length 詐称対策）
		if (!response.body) {
			const ab = await response.arrayBuffer();
			if (ab.byteLength > limitBytes) {
				throw new SlackFileTooLargeError(
					"Attachment exceeds the download limit",
				);
			}
			return new Uint8Array(ab);
		}

		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!value) continue;
				size += value.byteLength;
				if (size > limitBytes) {
					// 読み過ぎたら reader をキャンセルして上限エラー
					try {
						await reader.cancel();
					} catch {
						// ignore
					}
					throw new SlackFileTooLargeError(
						"Attachment exceeds the download limit",
					);
				}
				chunks.push(value);
			}
		} catch (error) {
			if (error instanceof SlackFileTooLargeError) {
				throw error;
			}
			if (signal?.aborted) {
				throw new SlackFileFetchError("Timed out fetching the attachment");
			}
			// reader からのエラーは汎用エラーとしてラップ
			if (error instanceof Error && error.name === "AbortError") {
				throw new SlackFileFetchError("Timed out fetching the attachment");
			}
			throw error;
		}

		// チャンクを結合
		const result = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return result;
	}

	throw new SlackFileTooManyRedirectsError("Too many attachment redirects");
}
