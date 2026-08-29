import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

/**
 * Tavily Search API のレスポンス（必要なフィールドのみ）。
 * https://docs.tavily.com/documentation/api-reference/endpoint/search
 */
interface TavilyResult {
	title: string;
	url: string;
	content: string;
	score: number;
	raw_content?: string | null;
}

interface TavilyResponse {
	query: string;
	answer?: string;
	results: TavilyResult[];
	response_time: number;
	images?: unknown[];
	request_id?: string;
}

/**
 * 自作の Tavily 検索ツール（ADR 0017）。
 *
 * - TAVILY_API_KEY は env から渡す（ハードコードしない）
 * - 無料枠は月1,000クレジット、超過分は $0.008/クレジット
 * - 本文抽出込みで返すため fetch での追いかけ回数が減る
 */
export function createTavilyTools(options: { apiKey?: string }): ToolSet {
	const apiKey = options.apiKey;

	return {
		tavily_search: tool({
			description:
				"Web検索（Tavily）。クエリに対して関連するWebページのタイトル・URL・本文スニペットを返す。最新情報や未知のトピックを調べる際に使う。",
			inputSchema: z.object({
				query: z
					.string()
					.min(1)
					.describe("検索クエリ（例: 'Cloudflare Workers とは'）"),
				maxResults: z
					.number()
					.int()
					.min(1)
					.max(10)
					.optional()
					.describe("最大結果数（1-10、既定 5）"),
				searchDepth: z
					.enum(["basic", "advanced"])
					.optional()
					.describe(
						"検索深度。basic=1クレジット、advanced=2クレジットで精度が高い（既定 basic）",
					),
				includeAnswer: z
					.boolean()
					.optional()
					.describe("LLM生成の回答を含めるか（既定 false）"),
				timeRange: z
					.enum(["day", "week", "month", "year"])
					.optional()
					.describe("期間フィルタ（例: 'week'で直近1週間）"),
			}),
			execute: async ({
				query,
				maxResults,
				searchDepth,
				includeAnswer,
				timeRange,
			}) => {
				if (!apiKey) {
					return {
						ok: false,
						error:
							"TAVILY_API_KEY is not configured. Web search is unavailable.",
					};
				}

				const body: Record<string, unknown> = {
					api_key: apiKey,
					query,
					max_results: maxResults ?? 5,
					search_depth: searchDepth ?? "basic",
					include_answer: includeAnswer ?? false,
					include_raw_content: false,
				};
				if (timeRange) {
					body.time_range = timeRange;
				}

				try {
					const res = await fetch("https://api.tavily.com/search", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${apiKey}`,
						},
						body: JSON.stringify(body),
					});

					if (!res.ok) {
						let detail = "";
						try {
							const errJson = (await res.json()) as {
								detail?: { error?: string };
								error?: string;
							};
							detail = errJson.detail?.error ?? errJson.error ?? "";
						} catch {
							try {
								detail = await res.text();
							} catch {
								detail = "";
							}
						}
						const message = detail
							? `${res.status} ${detail}`
							: `HTTP ${res.status}`;
						return {
							ok: false,
							error: `Tavily search failed: ${message}`,
							status: res.status,
						};
					}

					const data = (await res.json()) as TavilyResponse;

					// モデルに渡す出力をコンパクトに整形。生のレスポンスをそのまま返すと
					// トークンが増えすぎるため、必要なフィールドだけ残す。
					const results = (data.results ?? []).map((r) => ({
						title: r.title,
						url: r.url,
						content: r.content,
						score: r.score,
					}));

					const out: Record<string, unknown> = {
						ok: true,
						query: data.query,
						results,
						responseTime: data.response_time,
					};
					if (data.answer) {
						out.answer = data.answer;
					}
					return out;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						ok: false,
						error: `Tavily search request failed: ${message}`,
					};
				}
			},
		}),
	};
}
