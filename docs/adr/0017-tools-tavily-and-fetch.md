# ツールは Tavily 検索 + fetch の2つ

初期実装で有効にするツールは、自作の Tavily 検索ツールと Think の `fetch` ツール（`createFetchTools`）の2つ。

当初は「ツールは初期実装ではWeb検索のみ」としていたが、`@cloudflare/think@0.16.0` に Web検索ツールは存在しない。提供されるのは `workspace` / `fetch` / `browser` / `execute` / `sandbox` / `extensions` / MCP であり、検索は自前で用意する必要があった。

## Considered Options

- **Brave Search API**: 超過分が $5/1,000クエリで Tavily より安いが、返るのはリンク一覧のみ。本文を読むには `fetch` での追いかけが必須になり、往復とトークンが増える。
- **`browser` ツール（Cloudflare Browser Rendering）**: 外部APIキーは不要だがbindingが有料で、検索するには検索エンジンをスクレイプする形になり不安定。
- **ツール無し**: 最小構成にはなるが、Slackで「調べて」に応えられない。

Tavily は無料枠が月1,000クレジット（クレジットカード不要）、超過分は $0.008/クレジット。LLM向けに設計されていて検索結果とともに本文を抽出して返すため、`fetch` での追いかけ回数が減る。`fetch` も併せて有効にするのは、Slackではユーザーが直接URLを貼って「これ要約して」と頼む頻度が高いため。

## Consequences

- `TAVILY_API_KEY` が secret に増える
- ADR 0007（tool_result の compaction）はこの2つのツールの出力を対象とする。どちらも出力が大きくなりやすい
