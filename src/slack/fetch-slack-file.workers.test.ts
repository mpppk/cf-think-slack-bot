import { describe, expect, it, vi } from "vitest";
import {
	FETCH_LIMIT_BYTES,
	FETCH_MAX_REDIRECTS,
	fetchSlackFile,
	isAllowedSlackHost,
	isTrustedSlackOrigin,
	SLACK_ALLOWED_HOSTS,
	SlackFileFetchError,
	SlackFileMissingScopeError,
	SlackFileTooLargeError,
	SlackFileTooManyRedirectsError,
	TRUSTED_SLACK_ORIGINS,
} from "./fetch-slack-file";

// workerd 実環境で実行（ADR 0022）。添付ダウンロードの保護を検証する。
// issue #35: adapter の downloadAttachment が workerd で動かないため自前実装。

function mockResponse(
	body: string | Uint8Array,
	init: ResponseInit & { headers?: Record<string, string> } = {},
): Response {
	const headers = new Headers(init.headers);
	// body が文字列ならそのまま、Uint8Array なら渡す
	if (body instanceof Uint8Array) {
		return new Response(body as unknown as BodyInit, {
			...init,
			headers,
		});
	}
	return new Response(body, { ...init, headers });
}

describe("fetch-slack-file: isAllowedSlackHost", () => {
	it("slack.com とサブドメインを許可", () => {
		expect(isAllowedSlackHost("slack.com")).toBe(true);
		expect(isAllowedSlackHost("files.slack.com")).toBe(true);
		expect(isAllowedSlackHost("a.b.slack.com")).toBe(true);
		expect(isAllowedSlackHost("SLACK.COM")).toBe(true); // case-insensitive
	});

	it("slack-edge.com とサブドメインを許可", () => {
		expect(isAllowedSlackHost("slack-edge.com")).toBe(true);
		expect(isAllowedSlackHost("files.slack-edge.com")).toBe(true);
	});

	it("slack-files.com / slack-files-gov.com / slack-gov.com を許可", () => {
		expect(isAllowedSlackHost("slack-files.com")).toBe(true);
		expect(isAllowedSlackHost("slack-files-gov.com")).toBe(true);
		expect(isAllowedSlackHost("slack-gov.com")).toBe(true);
		expect(isAllowedSlackHost("files.slack-gov.com")).toBe(true);
	});

	it("allowlist 外は拒否", () => {
		expect(isAllowedSlackHost("evil.com")).toBe(false);
		expect(isAllowedSlackHost("evilslack.com")).toBe(false);
		expect(isAllowedSlackHost("slack.com.evil.com")).toBe(false);
		expect(isAllowedSlackHost("example.com")).toBe(false);
		expect(isAllowedSlackHost("192.168.1.1")).toBe(false);
	});

	it("SLACK_ALLOWED_HOSTS が期待通り", () => {
		expect(SLACK_ALLOWED_HOSTS).toContain("slack.com");
		expect(SLACK_ALLOWED_HOSTS).toContain("slack-edge.com");
	});
});

describe("fetch-slack-file: isTrustedSlackOrigin", () => {
	it("TRUSTED_SLACK_ORIGINS の origin は信頼する", () => {
		for (const origin of TRUSTED_SLACK_ORIGINS) {
			expect(isTrustedSlackOrigin(`${origin}/files-pri/xxx`)).toBe(true);
		}
	});

	it("サブドメインは信頼しない（exact origin のみ）", () => {
		expect(isTrustedSlackOrigin("https://sub.files.slack.com/xxx")).toBe(false);
		expect(isTrustedSlackOrigin("https://evil.com/xxx")).toBe(false);
	});

	it("apiUrl が渡されればその origin も信頼する", () => {
		expect(
			isTrustedSlackOrigin(
				"https://custom.example.com/api",
				"https://custom.example.com",
			),
		).toBe(true);
	});
});

describe("fetch-slack-file: fetchSlackFile の保護", () => {
	it("Slack ホスト以外への取得を拒否する（SSRF 対策）", async () => {
		const fetchMock = vi.fn(async () =>
			mockResponse("ok", {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			}),
		);
		await expect(
			fetchSlackFile("https://evil.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow("Refusing to fetch an untrusted attachment URL");
		expect(fetchMock).not.toHaveBeenCalled();

		await expect(
			fetchSlackFile("http://files.slack.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow("Refusing to fetch an untrusted attachment URL");
	});

	it("リダイレクト先が Slack ホストでなければ拒否する", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (
				url === "https://files.slack.com/files-pri/T123-F123/download/a.jpg"
			) {
				return mockResponse("", {
					status: 302,
					headers: { location: "https://evil.com/steal" },
				});
			}
			return mockResponse("should not be called", { status: 200 });
		});
		await expect(
			fetchSlackFile(
				"https://files.slack.com/files-pri/T123-F123/download/a.jpg",
				"xoxb-test",
				{ fetchImpl: fetchMock as unknown as typeof fetch },
			),
		).rejects.toThrow("Refusing to fetch an untrusted attachment URL");
		// 最初のリクエストは送られているが、リダイレクト先への fetch は拒否前に弾かれる
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("リダイレクト先が Slack ホストでなければ Authorization を送らない（手動追跡で漏洩しない）", async () => {
		// このケースは「Slack ホスト以外はそもそも拒否する」ため、
		// Authorization が送られないことを直接確認するには、
		// 許可ホスト内の非信頼 origin へのリダイレクトで確認する。
		// 例: files.slack.com (信頼) -> a.slack-edge.com (許可だが非信頼)
		const calls: Array<{ url: string; auth?: string }> = [];
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			calls.push({ url, auth: headers?.authorization });
			if (url === "https://files.slack.com/file.jpg") {
				return mockResponse("", {
					status: 302,
					headers: { location: "https://a.slack-edge.com/file.jpg" },
				});
			}
			if (url === "https://a.slack-edge.com/file.jpg") {
				return mockResponse(new Uint8Array([1, 2, 3]), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}
			return mockResponse("", { status: 404 });
		});
		const data = await fetchSlackFile(
			"https://files.slack.com/file.jpg",
			"xoxb-test-token",
			{
				fetchImpl: fetchMock as unknown as typeof fetch,
			},
		);
		expect(data).toBeDefined();
		// 1回目は信頼 origin なので Authorization 付き
		expect(calls[0]?.auth).toBe("Bearer xoxb-test-token");
		// 2回目は許可ホストだが非信頼 origin なので Authorization 無し
		expect(calls[1]?.auth).toBeUndefined();
	});

	it("リダイレクト回数の上限を超えたらエラー", async () => {
		const fetchMock = vi.fn(async () => {
			return mockResponse("", {
				status: 302,
				headers: { location: "https://files.slack.com/next" },
			});
		});
		await expect(
			fetchSlackFile("https://files.slack.com/start", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
				maxRedirects: 2,
			}),
		).rejects.toThrow(SlackFileTooManyRedirectsError);
		expect(fetchMock).toHaveBeenCalledTimes(3); // 0,1,2 で打ち止め
		fetchMock.mockClear();
		await expect(
			fetchSlackFile("https://files.slack.com/start", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
				maxRedirects: 2,
			}),
		).rejects.toThrow("Too many attachment redirects");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("FETCH_MAX_REDIRECTS が 5 である（adapter と同値）", () => {
		expect(FETCH_MAX_REDIRECTS).toBe(5);
	});

	it("content-length が上限超なら即エラー（ストリームを読む前に）", async () => {
		const fetchMock = vi.fn(async () =>
			mockResponse(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: {
					"content-type": "image/jpeg",
					"content-length": String(FETCH_LIMIT_BYTES + 1),
				},
			}),
		);
		await expect(
			fetchSlackFile("https://files.slack.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow(SlackFileTooLargeError);
		await expect(
			fetchSlackFile("https://files.slack.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow("Attachment exceeds the download limit");
	});

	it("ストリーム読み取り中に上限を超えたらエラー（content-length 詐称対策）", async () => {
		// content-length は小さいが、実際の body が大きいケース
		const large = new Uint8Array(FETCH_LIMIT_BYTES + 10);
		large.fill(0x61);
		const fetchMock = vi.fn(async () => {
			// content-length を詐称（小さく申告）
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					// 2回に分けて流す
					controller.enqueue(large.subarray(0, 1024));
					controller.enqueue(large.subarray(1024));
					controller.close();
				},
			});
			return new Response(stream as unknown as BodyInit, {
				status: 200,
				headers: {
					"content-type": "image/jpeg",
					"content-length": "1024",
				},
			});
		});
		await expect(
			fetchSlackFile("https://files.slack.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow(SlackFileTooLargeError);
	});

	it("content-type が text/html なら files:read 不足として専用エラー", async () => {
		const fetchMock = vi.fn(async () =>
			mockResponse("<html>login</html>", {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			}),
		);
		await expect(
			fetchSlackFile("https://files.slack.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow(SlackFileMissingScopeError);
		await expect(
			fetchSlackFile("https://files.slack.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			}),
		).rejects.toThrow("files:read");
	});

	it("正常な画像は取得できる（redirect: manual を使いつつ成功）", async () => {
		const body = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			expect((init as RequestInit)?.redirect).toBe("manual");
			expect(url).toBe("https://files.slack.com/file.png");
			// Authorization が付いていること
			const headers = init?.headers as Record<string, string>;
			expect(headers.authorization).toBe("Bearer xoxb-valid");
			return mockResponse(body, {
				status: 200,
				headers: { "content-type": "image/png" },
			});
		});
		const data = await fetchSlackFile(
			"https://files.slack.com/file.png",
			"xoxb-valid",
			{
				fetchImpl: fetchMock as unknown as typeof fetch,
			},
		);
		expect(data).toBeInstanceOf(Uint8Array);
		expect(data.length).toBe(4);
	});

	it("リダイレクトを手動で追って最終的に取得する", async () => {
		const body = new Uint8Array([1, 2, 3, 4]);
		const fetchMock = vi.fn(async (url: string) => {
			if (url === "https://files.slack.com/start") {
				return mockResponse("", {
					status: 302,
					headers: { location: "https://files.slack.com/next" },
				});
			}
			if (url === "https://files.slack.com/next") {
				return mockResponse(body, {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}
			return mockResponse("", { status: 404 });
		});
		const data = await fetchSlackFile(
			"https://files.slack.com/start",
			"xoxb-test",
			{
				fetchImpl: fetchMock as unknown as typeof fetch,
			},
		);
		expect(data.length).toBe(4);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("相対リダイレクト location も解決する", async () => {
		const body = new Uint8Array([9, 9]);
		const fetchMock = vi.fn(async (url: string) => {
			if (url === "https://files.slack.com/a/b") {
				return mockResponse("", {
					status: 302,
					headers: { location: "/c/d" },
				});
			}
			if (url === "https://files.slack.com/c/d") {
				return mockResponse(body, {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				});
			}
			return mockResponse("", { status: 404 });
		});
		const data = await fetchSlackFile(
			"https://files.slack.com/a/b",
			"xoxb-test",
			{
				fetchImpl: fetchMock as unknown as typeof fetch,
			},
		);
		expect(data.length).toBe(2);
	});

	it("fetch 失敗時のメッセージから URL を除去する（ログにファイル名が載らない）", async () => {
		const fetchMock = vi.fn(async () => {
			throw new TypeError(
				"Fetch API cannot load: https://files.slack.com/files-pri/T1-F1/secret.png",
			);
		});
		let error: unknown;
		try {
			await fetchSlackFile("https://files.slack.com/file.jpg", "xoxb-test", {
				fetchImpl: fetchMock as unknown as typeof fetch,
			});
		} catch (e) {
			error = e;
		}
		expect(error).toBeInstanceOf(SlackFileFetchError);
		const message = String((error as Error).message);
		// URL とファイル名が消え、<url> に置換されている
		expect(message).not.toContain("https://");
		expect(message).not.toContain("secret.png");
		expect(message).not.toContain("files-pri");
		expect(message).toContain("<url>");
		expect(message).toContain("Failed to fetch Slack file");
	});
});

describe("SlackBot: fetchMetadata.url からの自前復元（768ab1e / 9a96b0f 維持）", () => {
	it("DOホップ後（fetch無し・fetchMetadata.url有り）でも fetchSlackFile で取得して file part を注入する", async () => {
		const { SlackBot } = await import("./bot");
		const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
		// global fetch をモックして Slack からの画像取得を模擬
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			expect(url).toBe(
				"https://files.slack.com/files-pri/T123-F123/download/photo.jpg",
			);
			const headers = init?.headers as Record<string, string> | undefined;
			expect(headers?.authorization).toBe("Bearer xoxb-test");
			expect((init as RequestInit)?.redirect).toBe("manual");
			return mockResponse(imageBytes as unknown as Uint8Array, {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			});
		});
		(globalThis as unknown as { fetch: typeof fetch }).fetch =
			fetchMock as unknown as typeof fetch;
		try {
			const bot = Object.create(SlackBot.prototype) as InstanceType<
				typeof SlackBot
			>;
			(bot as unknown as { env: Env }).env = {
				SLACK_BOT_TOKEN: "xoxb-test",
				SLACK_SIGNING_SECRET: "test-secret",
				OPENROUTER_API_KEY: "test",
			} as Env;
			const sessionMock = {
				getLatestLeaf: vi.fn(async () => ({
					id: "msg-1",
					role: "user",
					parts: [{ type: "text", text: "hello" }],
				})),
				updateMessage: vi.fn(async () => {}),
			};
			(bot as unknown as { session: unknown }).session = sessionMock;
			(bot as unknown as { getMessengerContext: unknown }).getMessengerContext =
				() => ({
					message: {
						attachments: [
							{
								mediaType: "image/jpeg",
								mimeType: "image/jpeg",
								size: 1024,
								name: "photo.jpg",
								fetchMetadata: {
									url: "https://files.slack.com/files-pri/T123-F123/download/photo.jpg",
									teamId: "T123",
									enterpriseId: "E123",
									isEnterpriseInstall: "true",
								},
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
					{ role: "user", content: "この画像を説明して" } as unknown as Record<
						string,
						unknown
					>,
				],
				tools: {},
				model: {} as unknown as never,
				continuation: false,
			} as unknown as Parameters<
				InstanceType<typeof SlackBot>["beforeTurn"]
			>[0];

			const result = await bot.beforeTurn(ctx);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(result).toBeDefined();
			const messages = result?.messages as unknown as Array<{
				role: string;
				content: unknown;
			}>;
			const content = (messages[0] as unknown as { content: unknown[] })
				.content as unknown[];
			expect(Array.isArray(content)).toBe(true);
			const filePart = (content as Array<Record<string, unknown>>).find(
				(p) => p.type === "file",
			);
			expect(filePart).toBeDefined();
			expect(filePart?.mediaType).toBe("image/jpeg");
			expect(typeof filePart?.data).toBe("string");
			expect(
				(filePart as unknown as { data: string }).data.startsWith(
					"data:image/jpeg;base64,",
				),
			).toBe(true);
			expect(sessionMock.updateMessage).toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("fetchMetadata.url が Slack ホスト以外なら取得を試みず unfetchable としてログする（SSRF 対策を bot 経由でも維持）", async () => {
		const { SlackBot } = await import("./bot");
		const originalFetch = globalThis.fetch;
		const fetchMock = vi.fn(async () =>
			mockResponse(new Uint8Array([1]), {
				status: 200,
				headers: { "content-type": "image/jpeg" },
			}),
		);
		(globalThis as unknown as { fetch: typeof fetch }).fetch =
			fetchMock as unknown as typeof fetch;
		try {
			const bot = Object.create(SlackBot.prototype) as InstanceType<
				typeof SlackBot
			>;
			(bot as unknown as { env: Env }).env = {
				SLACK_BOT_TOKEN: "xoxb-test",
				SLACK_SIGNING_SECRET: "test",
			} as Env;
			(bot as unknown as { session: unknown }).session = {
				getLatestLeaf: vi.fn(async () => ({
					id: "msg-1",
					role: "user",
					parts: [{ type: "text", text: "hi" }],
				})),
				updateMessage: vi.fn(async () => {}),
			};
			(bot as unknown as { getMessengerContext: unknown }).getMessengerContext =
				() => ({
					message: {
						attachments: [
							{
								mediaType: "image/jpeg",
								size: 100,
								name: "evil.jpg",
								fetchMetadata: { url: "https://evil.com/file.jpg" },
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
				model: {} as unknown as never,
				continuation: false,
			} as unknown as Parameters<
				InstanceType<typeof SlackBot>["beforeTurn"]
			>[0];
			const result = await bot.beforeTurn(ctx);
			// 取得失敗で file part は注入されない
			expect(result).toBeUndefined();
			// fetch はホスト検証で弾かれ、外部へは行かない
			// fetchSlackFile は validate で throw するため、global fetch は呼ばれない
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
