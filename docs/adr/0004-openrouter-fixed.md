# OpenRouter z-ai/glm-5.3-flash 固定

`createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })` で `z-ai/glm-5.3-flash` をコードに直書きする。temperature等はデフォルト、フォールバック無し、コスト上限無し。

## Considered Options

- **`deepseek/deepseek-v4-flash-0731`（当初の決定）**: OpenRouterのmodels APIで確認したところ `input_modalities: ["text"]` のテキスト専用で、画像をVisionへ渡す ADR 0006 と両立しなかった。フォールバック無しの構成では、画像が1枚届いた時点でそのリクエストが確実に失敗する。
- **Workers AI（`@cf/moonshotai/kimi-k2.6` / `@cf/meta/llama-4-scout-17b-16e-instruct` / `@cf/google/gemma-4-26b-a4b-it`）**: モデルの入れ替えがCloudflare側のカタログに縛られ、OpenRouterのように1行で差し替えられない。日本語品質の比較検証も必要になる。`ai` bindingが不要になる分 `wrangler.jsonc` は単純になるが、それだけの理由では選ばない。
- **`deepseek/deepseek-v4-flash-vision-exp`**: vision対応だがモデルIDの `exp` は実験版を示し、予告なく提供終了しうる。フォールバックを持たない構成の土台には不適。
- **`google/gemini-3.7-flash`**: vision対応で日本語品質は高いが $0.375/$1.875 と5倍前後。個人利用では絶対額が小さいので、品質を優先するならここへ戻す余地はある。

`z-ai/glm-5.3-flash` は vision対応・ctx 1.31M・$0.075/$0.25 で、当初モデルのコスト感とコンテキスト長を保ったまま画像機能を満たす。

## Consequences

モデルIDを直書きするため、OpenRouter側でIDが失効するとボットが全面停止する。フォールバックが無いのは意図的な選択であり（構成を単純に保つため）、停止に気づく手段は Workers Logs のみ（ADR 0018）。

レート制限・コスト上限・ACLを実装しないのも意図的な選択で、検証用の個人ワークスペース（README参照）に手動招待でのみ入れる前提に依存している。他ワークスペースへ展開する場合はこの前提が崩れるため、ユーザー単位のレート制限を先に入れること。運用上の保険としてOpenRouterアカウント側でクレジット上限を設定する。
