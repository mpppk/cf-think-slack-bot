/**
 * 画像添付のフィルタと Vision への受け渡し（ADR 0006, 仕様§3.4）。
 *
 * - 許可: jpeg / png / webp、1枚10MB以下、1メッセージ4枚までを Vision でモデルへ渡す
 * - 非画像・5枚目以降・10MB超は Session に保存せず、日本語1行で通知する
 * - 取得は attachment.fetchData() に委譲する。Session に残すのは fetchMetadata.url で、
 *   過去ターンの画像は必要時に再取得する（rehydrateAttachment）
 * - Slack App に files:read が必須。無いと Slack が HTML ログインページを返す
 * - ユーザーが Slack 上でファイルを削除すると過去ターンの画像は再取得できない（許容）
 */

export const ALLOWED_IMAGE_MIME_TYPES = new Set<string>([
	"image/jpeg",
	"image/png",
	"image/webp",
]);

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_IMAGES_PER_MESSAGE = 4;

// 日本語1行通知（仕様§3.4）。各文面は ADR 0006 の引用句を含む。
export const NOTICE_NON_IMAGE = "画像以外は未対応のため、添付を無視しました。";
export const NOTICE_TOO_MANY = "画像は4枚までです。5枚目以降は無視しました。";
export const NOTICE_TOO_LARGE = "10MB超は未対応のため、添付を無視しました。";

// 後方互換: 旧・テストが期待するエイリアス（必要なら）
export const ALLOWED_IMAGE_MIMETYPES = ALLOWED_IMAGE_MIME_TYPES;

/**
 * 添付の入力。Slack adapter の Attachment と Think の MessengerAttachment の
 * 共通部分を緩く受ける。mimeType / mediaType のどちらかが入る。
 */
export type AttachmentInput = {
	mimeType?: string;
	mediaType?: string;
	type?: string;
	size?: number;
	name?: string;
	url?: string;
	fetchMetadata?: Record<string, string>;
	fetch?: () => Promise<ArrayBuffer>;
	fetchData?: () => Promise<Buffer | ArrayBuffer | Uint8Array>;
};

export type FilterResult = {
	accepted: AttachmentInput[];
	notices: string[];
	hasNonImage: boolean;
	hasTooMany: boolean;
	hasTooLarge: boolean;
};

function getMimeType(att: AttachmentInput): string {
	return att.mediaType ?? att.mimeType ?? "";
}

function isAllowedImageMimeType(mime: string): boolean {
	// 小文字で正規化。charset 等が付くことは Slack では無いが念のため prefix 前で切る
	const normalized = mime.split(";")[0]?.trim().toLowerCase() ?? "";
	return ALLOWED_IMAGE_MIME_TYPES.has(normalized);
}

/**
 * 1メッセージ内の添付をフィルタする純粋関数。
 *
 * - 先頭から順に 4枚まで許可。5枚目以降は hasTooMany
 * - mime が image/jpeg, image/png, image/webp でなければ hasNonImage
 * - size が 10MB 超なら hasTooLarge
 * - いずれも Session に保存せず、呼び出し側が notices を1行で通知する
 */
export function filterAttachments(
	attachments: AttachmentInput[],
): FilterResult {
	const accepted: AttachmentInput[] = [];
	const notices: string[] = [];
	let hasNonImage = false;
	let hasTooLarge = false;
	let hasTooMany = false;

	for (const att of attachments) {
		if (accepted.length >= MAX_IMAGES_PER_MESSAGE) {
			hasTooMany = true;
			continue;
		}
		const mime = getMimeType(att);
		if (!isAllowedImageMimeType(mime)) {
			hasNonImage = true;
			continue;
		}
		if (typeof att.size === "number" && att.size > MAX_IMAGE_BYTES) {
			hasTooLarge = true;
			continue;
		}
		accepted.push(att);
	}

	if (hasNonImage) {
		notices.push(NOTICE_NON_IMAGE);
	}
	if (hasTooLarge) {
		notices.push(NOTICE_TOO_LARGE);
	}
	if (hasTooMany) {
		notices.push(NOTICE_TOO_MANY);
	}

	return { accepted, notices, hasNonImage, hasTooMany, hasTooLarge };
}

/**
 * ArrayBuffer / Buffer / Uint8Array を base64 data URL へ変換する。
 * workerd は nodejs_compat で Buffer が使える。
 */
export function toDataUrl(
	data: ArrayBuffer | Buffer | Uint8Array,
	mediaType: string,
): string {
	let buffer: Buffer;
	if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
		buffer = data as Buffer;
	} else if (data instanceof Uint8Array) {
		buffer = Buffer.from(data as Uint8Array);
	} else if (data instanceof ArrayBuffer) {
		buffer = Buffer.from(new Uint8Array(data));
	} else {
		// フォールバック: ArrayBuffer 互換
		buffer = Buffer.from(data as unknown as Uint8Array);
	}
	return `data:${mediaType};base64,${buffer.toString("base64")}`;
}

export type FileUIPart = {
	type: "file";
	mediaType: string;
	url: string; // data URL
	filename?: string;
};

/**
 * 許可された添付を fetchData/fetch で取得し、FileUIPart (data URL) へ変換する。
 * 取得は呼び出し側が attachment.fetchData() に委譲する仕様に従う。
 * 中間ストレージを介さず、Slack の url_private へ Bearer token で取得する点は
 * adapter の fetchSlackFile が担う（files:read が無いと HTML が返り NetworkError）。
 */
export async function fetchAttachmentsAsFileParts(
	attachments: AttachmentInput[],
): Promise<FileUIPart[]> {
	const parts: FileUIPart[] = [];
	for (const att of attachments) {
		const mime = getMimeType(att);
		const fetchFn:
			| (() => Promise<ArrayBuffer | Buffer | Uint8Array>)
			| undefined =
			(att as { fetch?: () => Promise<ArrayBuffer> }).fetch ??
			(att as { fetchData?: () => Promise<Buffer | ArrayBuffer> }).fetchData;
		if (!fetchFn) {
			continue;
		}
		const data = await fetchFn();
		if (!data) {
			continue;
		}
		// data が ArrayBuffer でも Buffer でも扱えるように toDataUrl で吸収
		const url = toDataUrl(data as ArrayBuffer, mime);
		parts.push({
			type: "file",
			mediaType: mime,
			url,
			filename: att.name,
		});
	}
	return parts;
}

/**
 * 添付の検証ヘルパ（単体テスト用）。
 */
export function isAllowedImageAttachment(att: AttachmentInput): boolean {
	const mime = getMimeType(att);
	if (!isAllowedImageMimeType(mime)) {
		return false;
	}
	if (typeof att.size === "number" && att.size > MAX_IMAGE_BYTES) {
		return false;
	}
	return true;
}
