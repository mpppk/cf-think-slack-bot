import { describe, expect, it, vi } from "vitest";
import {
	ALLOWED_IMAGE_MIME_TYPES,
	fetchAttachmentsAsFileParts,
	filterAttachments,
	isAllowedImageAttachment,
	MAX_IMAGE_BYTES,
	MAX_IMAGES_PER_MESSAGE,
	NOTICE_NON_IMAGE,
	NOTICE_TOO_LARGE,
	NOTICE_TOO_MANY,
	toDataUrl,
} from "./attachment";
import { SlackBot } from "./bot";

// workerd 環境で実行（ADR 0022）。仕様§3.4 (ADR 0006) の画像添付フィルタと通知を検証する。

function makeImageAttachment(
	overrides: Partial<{
		mimeType: string;
		mediaType: string;
		size: number;
		name: string;
		fetch: () => Promise<ArrayBuffer>;
		fetchData: () => Promise<Buffer>;
	}> = {},
): {
	mimeType?: string;
	mediaType?: string;
	size?: number;
	name?: string;
	fetch?: () => Promise<ArrayBuffer>;
	fetchData?: () => Promise<Buffer>;
} {
	return {
		mimeType: "image/jpeg",
		size: 1024,
		name: "photo.jpg",
		...overrides,
	};
}

describe("attachment: 定数", () => {
	it("許可は jpeg / png / webp の3つ", () => {
		expect(ALLOWED_IMAGE_MIME_TYPES.has("image/jpeg")).toBe(true);
		expect(ALLOWED_IMAGE_MIME_TYPES.has("image/png")).toBe(true);
		expect(ALLOWED_IMAGE_MIME_TYPES.has("image/webp")).toBe(true);
		expect(ALLOWED_IMAGE_MIME_TYPES.size).toBe(3);
	});

	it("HEIC は許可外", () => {
		expect(ALLOWED_IMAGE_MIME_TYPES.has("image/heic")).toBe(false);
		expect(ALLOWED_IMAGE_MIME_TYPES.has("image/heif")).toBe(false);
	});

	it("10MB が上限", () => {
		expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
	});

	it("1メッセージ4枚まで", () => {
		expect(MAX_IMAGES_PER_MESSAGE).toBe(4);
	});

	it("通知文が ADR 0006 の引用句を含む", () => {
		expect(NOTICE_NON_IMAGE).toContain("画像以外は未対応");
		expect(NOTICE_TOO_MANY).toContain("4枚までです");
		expect(NOTICE_TOO_LARGE).toContain("10MB超は未対応");
	});

	it("通知文が日本語1行（改行無し）", () => {
		for (const notice of [
			NOTICE_NON_IMAGE,
			NOTICE_TOO_MANY,
			NOTICE_TOO_LARGE,
		]) {
			expect(notice.includes("\n")).toBe(false);
			expect(notice.length).toBeGreaterThan(0);
		}
	});
});

describe("attachment: filterAttachments", () => {
	it("jpeg / png / webp を許可する", () => {
		const attachments = [
			makeImageAttachment({ mimeType: "image/jpeg" }),
			makeImageAttachment({ mimeType: "image/png" }),
			makeImageAttachment({ mimeType: "image/webp" }),
			makeImageAttachment({ mediaType: "image/jpeg" }), // mediaType 側
		];
		const { accepted, notices } = filterAttachments(attachments as never);
		expect(accepted).toHaveLength(4);
		expect(notices).toHaveLength(0);
	});

	it("4枚まで許可、5枚目は Session に保存せず通知", () => {
		const attachments = Array.from({ length: 5 }, (_, i) =>
			makeImageAttachment({ name: `img${i}.jpg`, mimeType: "image/jpeg" }),
		);
		const { accepted, notices, hasTooMany } = filterAttachments(
			attachments as never,
		);
		expect(accepted).toHaveLength(4);
		expect(hasTooMany).toBe(true);
		expect(notices).toContain(NOTICE_TOO_MANY);
		// 5枚目は保存されない
		expect(accepted.map((a) => a.name)).not.toContain("img4.jpg");
	});

	it("10MB超は Session に保存せず通知", () => {
		const attachments = [
			makeImageAttachment({ mimeType: "image/jpeg", size: 1024 }),
			makeImageAttachment({
				mimeType: "image/png",
				size: MAX_IMAGE_BYTES + 1,
				name: "large.png",
			}),
		];
		const { accepted, notices, hasTooLarge } = filterAttachments(
			attachments as never,
		);
		expect(accepted).toHaveLength(1);
		expect(hasTooLarge).toBe(true);
		expect(notices).toContain(NOTICE_TOO_LARGE);
		expect(accepted[0]?.name).not.toBe("large.png");
	});

	it("10MBちょうどは許可", () => {
		const attachments = [
			makeImageAttachment({ mimeType: "image/jpeg", size: MAX_IMAGE_BYTES }),
		];
		const { accepted, notices } = filterAttachments(attachments as never);
		expect(accepted).toHaveLength(1);
		expect(notices).toHaveLength(0);
	});

	it("非画像（pdf, text, heic, video）は保存せず通知", () => {
		const attachments = [
			makeImageAttachment({ mimeType: "application/pdf", name: "doc.pdf" }),
			makeImageAttachment({ mimeType: "text/plain", name: "note.txt" }),
			makeImageAttachment({ mimeType: "image/heic", name: "photo.heic" }),
			makeImageAttachment({ mimeType: "video/mp4", name: "movie.mp4" }),
			makeImageAttachment({ mimeType: "audio/mpeg", name: "sound.mp3" }),
		];
		const { accepted, notices, hasNonImage } = filterAttachments(
			attachments as never,
		);
		expect(accepted).toHaveLength(0);
		expect(hasNonImage).toBe(true);
		expect(notices).toContain(NOTICE_NON_IMAGE);
	});

	it("非画像・5枚目以降・10MB超が同時にあると各通知が1行ずつ（重複排除）", () => {
		const attachments = [
			makeImageAttachment({ mimeType: "application/pdf", name: "a.pdf" }),
			makeImageAttachment({
				mimeType: "image/jpeg",
				size: MAX_IMAGE_BYTES + 100,
				name: "big.jpg",
			}),
			...Array.from({ length: 5 }, (_, i) =>
				makeImageAttachment({ name: `img${i}.jpg`, mimeType: "image/jpeg" }),
			),
		];
		const { accepted, notices } = filterAttachments(attachments as never);
		// pdf と big.jpg は除外、残り5枚のうち4枚まで許可
		expect(accepted).toHaveLength(4);
		expect(notices).toContain(NOTICE_NON_IMAGE);
		expect(notices).toContain(NOTICE_TOO_LARGE);
		expect(notices).toContain(NOTICE_TOO_MANY);
		// 各カテゴリ1回ずつ、重複しない
		expect(notices).toHaveLength(3);
	});

	it("複数非画像があっても通知は1回", () => {
		const attachments = [
			makeImageAttachment({ mimeType: "application/pdf" }),
			makeImageAttachment({ mimeType: "text/plain" }),
		];
		const { notices } = filterAttachments(attachments as never);
		expect(notices.filter((n) => n === NOTICE_NON_IMAGE)).toHaveLength(1);
	});

	it("複数10MB超があっても通知は1回", () => {
		const attachments = [
			makeImageAttachment({
				mimeType: "image/jpeg",
				size: MAX_IMAGE_BYTES + 1,
			}),
			makeImageAttachment({
				mimeType: "image/png",
				size: MAX_IMAGE_BYTES + 2,
			}),
		];
		const { notices } = filterAttachments(attachments as never);
		expect(notices.filter((n) => n === NOTICE_TOO_LARGE)).toHaveLength(1);
	});

	it("mimeType / mediaType どちらでも判定する", () => {
		const viaMime = filterAttachments([
			makeImageAttachment({ mimeType: "image/jpeg", mediaType: undefined }),
		] as never);
		const viaMedia = filterAttachments([
			makeImageAttachment({ mimeType: undefined, mediaType: "image/jpeg" }),
		] as never);
		expect(viaMime.accepted).toHaveLength(1);
		expect(viaMedia.accepted).toHaveLength(1);
	});

	it("size が undefined でも許可（fetch 後に再評価）", () => {
		const attachments = [makeImageAttachment({ size: undefined })];
		const { accepted } = filterAttachments(attachments as never);
		expect(accepted).toHaveLength(1);
	});

	it("空配列は空結果", () => {
		const { accepted, notices } = filterAttachments([]);
		expect(accepted).toHaveLength(0);
		expect(notices).toHaveLength(0);
	});
});

describe("attachment: isAllowedImageAttachment", () => {
	it("jpeg は許可", () => {
		expect(
			isAllowedImageAttachment({ mimeType: "image/jpeg", size: 100 }),
		).toBe(true);
	});
	it("heic は非許可", () => {
		expect(
			isAllowedImageAttachment({ mimeType: "image/heic", size: 100 }),
		).toBe(false);
	});
	it("10MB超は非許可", () => {
		expect(
			isAllowedImageAttachment({
				mimeType: "image/jpeg",
				size: MAX_IMAGE_BYTES + 1,
			}),
		).toBe(false);
	});
});

describe("attachment: toDataUrl", () => {
	it("Buffer を data URL へ変換する", () => {
		const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG header
		const url = toDataUrl(buf, "image/png");
		expect(url).toBe(`data:image/png;base64,${buf.toString("base64")}`);
		expect(url.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("ArrayBuffer を data URL へ変換する", () => {
		const ab = new Uint8Array([1, 2, 3, 4]).buffer as ArrayBuffer;
		const url = toDataUrl(ab, "image/jpeg");
		expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);
	});

	it("Uint8Array を data URL へ変換する", () => {
		const u8 = new Uint8Array([5, 6, 7]);
		const url = toDataUrl(u8, "image/webp");
		expect(url.startsWith("data:image/webp;base64,")).toBe(true);
	});
});

describe("attachment: fetchAttachmentsAsFileParts", () => {
	it("fetchData に委譲して FileUIPart を作る", async () => {
		const data = Buffer.from("fake-image-data");
		const attachments = [
			{
				mimeType: "image/jpeg",
				mediaType: "image/jpeg",
				name: "photo.jpg",
				fetchData: async () => data,
			},
		];
		const parts = await fetchAttachmentsAsFileParts(attachments as never);
		expect(parts).toHaveLength(1);
		expect(parts[0]?.type).toBe("file");
		expect(parts[0]?.mediaType).toBe("image/jpeg");
		expect(parts[0]?.url.startsWith("data:image/jpeg;base64,")).toBe(true);
		expect(parts[0]?.filename).toBe("photo.jpg");
	});

	it("fetch (MessengerAttachment) にも対応する", async () => {
		const ab = new Uint8Array([1, 2, 3]).buffer as ArrayBuffer;
		const attachments = [
			{
				mediaType: "image/png",
				name: "a.png",
				fetch: async () => ab,
			},
		];
		const parts = await fetchAttachmentsAsFileParts(attachments as never);
		expect(parts).toHaveLength(1);
		expect(parts[0]?.mediaType).toBe("image/png");
	});

	it("fetch が無い添付はスキップする", async () => {
		const attachments = [{ mimeType: "image/jpeg", name: "no-fetch.jpg" }];
		const parts = await fetchAttachmentsAsFileParts(attachments as never);
		expect(parts).toHaveLength(0);
	});

	it("複数画像を順に fetch する", async () => {
		const attachments = [0, 1, 2].map((i) => ({
			mimeType: "image/jpeg",
			name: `img${i}.jpg`,
			fetchData: async () => Buffer.from(`data-${i}`),
		}));
		const parts = await fetchAttachmentsAsFileParts(attachments as never);
		expect(parts).toHaveLength(3);
		for (const p of parts) {
			expect(p.type).toBe("file");
			expect(p.url.startsWith("data:image/jpeg;base64,")).toBe(true);
		}
	});
});

describe("SlackBot: 画像添付の Vision 受け渡し（仕様§3.4）", () => {
	function createBot(opts: {
		deliverNoticeMock?: ReturnType<typeof vi.fn>;
		sessionMock?: {
			getLatestLeaf: ReturnType<typeof vi.fn>;
			updateMessage: ReturnType<typeof vi.fn>;
		};
		messengerAttachments?: unknown[];
	}): SlackBot {
		const bot = Object.create(SlackBot.prototype) as SlackBot;
		(bot as unknown as { env: Env }).env = {
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
			OPENROUTER_API_KEY: "test",
		} as Env;

		// Session をモック
		const sessionMock = opts.sessionMock ?? {
			getLatestLeaf: vi.fn(async () => ({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "hello" }],
			})),
			updateMessage: vi.fn(async () => {}),
		};
		(bot as unknown as { session: unknown }).session = sessionMock;

		// getMessengerContext をモック
		(bot as unknown as { getMessengerContext: unknown }).getMessengerContext =
			() => ({
				message: {
					attachments: opts.messengerAttachments ?? [],
				},
			});

		// deliverNotice をモック
		(bot as unknown as { deliverNotice: unknown }).deliverNotice =
			opts.deliverNoticeMock ?? vi.fn(async () => {});

		return bot;
	}

	it("画像添付質問を Vision でモデルへ渡す（beforeTurn が file part を注入）", async () => {
		const data = Buffer.from("fake-jpeg");
		const deliverNotice = vi.fn(async () => {});
		const sessionMock = {
			getLatestLeaf: vi.fn(async () => ({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "この画像を説明して" }],
			})),
			updateMessage: vi.fn(async () => {}),
		};
		const bot = createBot({
			deliverNoticeMock: deliverNotice,
			sessionMock,
			messengerAttachments: [
				{
					mediaType: "image/jpeg",
					mimeType: "image/jpeg",
					size: 1024,
					name: "photo.jpg",
					fetch: async () =>
						data.buffer.slice(
							data.byteOffset,
							data.byteOffset + data.byteLength,
						),
				},
			],
		});

		const ctx = {
			system: "system",
			messages: [
				{ role: "user", content: "この画像を説明して" } as unknown as Record<
					string,
					unknown
				>,
			],
			tools: {},
			model: {} as unknown as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];

		const result = await bot.beforeTurn(ctx);

		// file part が注入されている
		expect(result).toBeDefined();
		const messages = result?.messages as unknown as Array<{
			role: string;
			content: unknown;
		}>;
		expect(messages).toBeDefined();
		if (!messages || messages.length === 0) throw new Error("no messages");
		const msg = messages[0] as { content: unknown };
		expect(msg).toBeDefined();
		const content = msg.content as unknown[];
		// text + file の2要素
		expect(Array.isArray(content)).toBe(true);
		expect((content as unknown[]).length).toBeGreaterThanOrEqual(2);
		const filePart = (content as Array<Record<string, unknown>>).find(
			(p) => p.type === "file",
		);
		expect(filePart).toBeDefined();
		if (!filePart) throw new Error("filePart missing");
		expect(filePart.mediaType).toBe("image/jpeg");
		expect(typeof filePart.data).toBe("string");
		expect(
			(filePart.data as string).startsWith("data:image/jpeg;base64,"),
		).toBe(true);

		// 通知は無い
		expect(deliverNotice).not.toHaveBeenCalled();

		// Session にも保存される
		expect(sessionMock.updateMessage).toHaveBeenCalled();
		const updated = (
			sessionMock.updateMessage.mock.calls as unknown as unknown[][]
		)[0]?.[0] as unknown as {
			parts: unknown[];
		};
		expect(
			updated.parts.some(
				(p: unknown) => (p as { type: string }).type === "file",
			),
		).toBe(true);
	});

	it("5枚目は Session に保存せず「4枚までです」と通知する", async () => {
		const deliverNotice = vi.fn(async () => {});
		const bot = createBot({
			deliverNoticeMock: deliverNotice,
			messengerAttachments: Array.from({ length: 5 }, (_, i) => ({
				mediaType: "image/jpeg",
				mimeType: "image/jpeg",
				size: 1024,
				name: `img${i}.jpg`,
				fetch: async () => new Uint8Array([1, 2, 3]).buffer as ArrayBuffer,
			})),
		});

		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "5枚送る" } as unknown as Record<
					string,
					unknown
				>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];

		await bot.beforeTurn(ctx);

		expect(deliverNotice).toHaveBeenCalledWith(
			expect.stringContaining("4枚までです"),
		);
		// 通知は日本語1行
		const notice = (
			deliverNotice.mock.calls as unknown as unknown[][]
		)[0]?.[0] as unknown as string;
		expect(notice.includes("\n")).toBe(false);
	});

	it("10MB超は Session に保存せず「10MB超は未対応」と通知する", async () => {
		const deliverNotice = vi.fn(async () => {});
		const bot = createBot({
			deliverNoticeMock: deliverNotice,
			messengerAttachments: [
				{
					mediaType: "image/jpeg",
					size: MAX_IMAGE_BYTES + 1,
					name: "big.jpg",
					fetch: async () => new ArrayBuffer(10),
				},
			],
		});
		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "大きい画像" } as unknown as Record<
					string,
					unknown
				>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];

		const result = await bot.beforeTurn(ctx);

		expect(deliverNotice).toHaveBeenCalledWith(
			expect.stringContaining("10MB超は未対応"),
		);
		// file part は注入されない
		expect(result).toBeUndefined();
	});

	it("非画像は Session に保存せず「画像以外は未対応」と通知する", async () => {
		const deliverNotice = vi.fn(async () => {});
		const bot = createBot({
			deliverNoticeMock: deliverNotice,
			messengerAttachments: [
				{
					mediaType: "application/pdf",
					size: 1024,
					name: "doc.pdf",
					fetch: async () => new ArrayBuffer(10),
				},
				{
					mediaType: "image/heic",
					size: 1024,
					name: "photo.heic",
					fetch: async () => new ArrayBuffer(10),
				},
			],
		});
		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "pdf" } as unknown as Record<string, unknown>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];

		const result = await bot.beforeTurn(ctx);

		expect(deliverNotice).toHaveBeenCalledWith(
			expect.stringContaining("画像以外は未対応"),
		);
		expect(result).toBeUndefined();
	});

	it("jpeg / png / webp のみ許可し、他は通知する（HEIC 含む）", async () => {
		const cases: Array<{ mime: string; allowed: boolean }> = [
			{ mime: "image/jpeg", allowed: true },
			{ mime: "image/png", allowed: true },
			{ mime: "image/webp", allowed: true },
			{ mime: "image/heic", allowed: false },
			{ mime: "image/heif", allowed: false },
			{ mime: "video/mp4", allowed: false },
			{ mime: "application/pdf", allowed: false },
		];
		for (const { mime, allowed } of cases) {
			const deliverNotice = vi.fn(async () => {});
			const bot = createBot({
				deliverNoticeMock: deliverNotice,
				messengerAttachments: [
					{
						mediaType: mime,
						size: 100,
						name: "file",
						fetch: async () => new ArrayBuffer(8),
					},
				],
			});
			const ctx = {
				system: "",
				messages: [
					{ role: "user", content: "test" } as unknown as Record<
						string,
						unknown
					>,
				],
				tools: {},
				model: {} as never,
				continuation: false,
			} as unknown as Parameters<SlackBot["beforeTurn"]>[0];
			const result = await bot.beforeTurn(ctx);
			if (allowed) {
				expect(result).toBeDefined();
				expect(deliverNotice).not.toHaveBeenCalled();
			} else {
				expect(deliverNotice).toHaveBeenCalledWith(
					expect.stringContaining("画像以外は未対応"),
				);
			}
		}
	});

	it("複数上限超過が同時にあると各通知が1行ずつ（重複排除）", async () => {
		const deliverNotice = vi.fn(async () => {});
		const bot = createBot({
			deliverNoticeMock: deliverNotice,
			messengerAttachments: [
				{
					mediaType: "application/pdf",
					size: 100,
					name: "a.pdf",
					fetch: async () => new ArrayBuffer(4),
				},
				{
					mediaType: "image/jpeg",
					size: MAX_IMAGE_BYTES + 10,
					name: "big.jpg",
					fetch: async () => new ArrayBuffer(4),
				},
				...Array.from({ length: 5 }, (_, i) => ({
					mediaType: "image/jpeg",
					size: 100,
					name: `img${i}.jpg`,
					fetch: async () => new ArrayBuffer(4),
				})),
			],
		});
		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "mix" } as unknown as Record<string, unknown>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];

		await bot.beforeTurn(ctx);

		expect(deliverNotice).toHaveBeenCalledWith(
			expect.stringContaining("画像以外は未対応"),
		);
		expect(deliverNotice).toHaveBeenCalledWith(
			expect.stringContaining("10MB超は未対応"),
		);
		expect(deliverNotice).toHaveBeenCalledWith(
			expect.stringContaining("4枚までです"),
		);
		expect(deliverNotice).toHaveBeenCalledTimes(3);
	});

	it("fetchData に委譲して取得する（fetchData でも取得できる）", async () => {
		const data = Buffer.from("hello-world");
		const deliverNotice = vi.fn(async () => {});
		const bot = createBot({
			deliverNoticeMock: deliverNotice,
			messengerAttachments: [
				{
					mimeType: "image/jpeg",
					mediaType: "image/jpeg",
					size: 100,
					name: "a.jpg",
					fetchData: async () => data,
				},
			],
		});
		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "fetchData test" } as unknown as Record<
					string,
					unknown
				>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];

		const result = await bot.beforeTurn(ctx);
		expect(result).toBeDefined();
		const messages = result?.messages as unknown as Array<{
			role: string;
			content: unknown;
		}>;
		expect(messages).toBeDefined();
		expect(messages.length).toBeGreaterThan(0);
		const first = messages[0] as { content: unknown };
		const content = first.content as unknown[];
		const filePart = (content as Array<Record<string, unknown>>).find(
			(p) => p.type === "file",
		);
		expect(filePart).toBeDefined();
		expect(typeof (filePart as Record<string, unknown>).data).toBe("string");
		expect(
			((filePart as Record<string, unknown>).data as string).includes(
				data.toString("base64"),
			),
		).toBe(true);
	});

	it("添付が無いときは beforeTurn が no-op", async () => {
		const bot = createBot({ messengerAttachments: [] });
		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "hello" } as unknown as Record<
					string,
					unknown
				>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];
		const result = await bot.beforeTurn(ctx);
		expect(result).toBeUndefined();
	});

	it("fetch が無い添付はスキップする", async () => {
		const deliverNotice = vi.fn(async () => {});
		const bot = createBot({
			deliverNoticeMock: deliverNotice,
			messengerAttachments: [
				{ mediaType: "image/jpeg", size: 100, name: "no-fetch.jpg" }, // fetch 無し
			],
		});
		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "no fetch" } as unknown as Record<
					string,
					unknown
				>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];
		const result = await bot.beforeTurn(ctx);
		// fetch が無いので file part は作られない
		expect(result).toBeUndefined();
	});
});

describe("attachment: fetchMetadata.url の保持（ADR 0006）", () => {
	it("Session に保存する file part は url を持つ（再取得の起点）", async () => {
		const data = Buffer.from("img");
		const sessionMock = {
			getLatestLeaf: vi.fn(async () => ({
				id: "msg-1",
				role: "user",
				parts: [{ type: "text", text: "hi" }],
			})),
			updateMessage: vi.fn(async () => {}),
		};
		const bot = Object.create(SlackBot.prototype) as SlackBot;
		(bot as unknown as { env: Env }).env = {
			SLACK_BOT_TOKEN: "xoxb-test",
			SLACK_SIGNING_SECRET: "test-secret",
		} as Env;
		(bot as unknown as { session: unknown }).session = sessionMock;
		(bot as unknown as { getMessengerContext: unknown }).getMessengerContext =
			() => ({
				message: {
					attachments: [
						{
							mediaType: "image/jpeg",
							mimeType: "image/jpeg",
							size: 100,
							name: "a.jpg",
							fetchMetadata: {
								url: "https://files.slack.com/files-pri/T123-F123/download/a.jpg",
							},
							fetch: async () =>
								data.buffer.slice(
									data.byteOffset,
									data.byteOffset + data.byteLength,
								),
						},
					],
				},
			});
		(bot as unknown as { deliverNotice: unknown }).deliverNotice = vi.fn(
			async () => {},
		);

		const ctx = {
			system: "",
			messages: [
				{ role: "user", content: "hi" } as unknown as Record<string, unknown>,
			],
			tools: {},
			model: {} as never,
			continuation: false,
		} as unknown as Parameters<SlackBot["beforeTurn"]>[0];

		await bot.beforeTurn(ctx);

		// Session の updateMessage に file part が渡されている
		expect(sessionMock.updateMessage).toHaveBeenCalled();
		const updated = (
			sessionMock.updateMessage.mock.calls as unknown as unknown[][]
		)[0]?.[0] as {
			parts: Array<{ type: string; url?: string }>;
		};
		const filePart = updated.parts.find((p) => p.type === "file");
		expect(filePart?.url?.startsWith("data:image/jpeg;base64,")).toBe(true);
	});
});
