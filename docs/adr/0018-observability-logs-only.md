# 観測性は Workers Logs のみ、Langfuse は不採用

監視は Workers Logs / Tail のみとする。Langfuse連携（`withSpan` / `finishMeteredInference` / `ctx.recordGeneration()`）は個人利用のボットに対して運用コストが見合わないため採用しない。

トレース基盤を後から入れたくなった場合に再検討する余地はあるが、「まだ入れていない」のではなく「意図的に入れていない」ことを記録しておく。

ログしか無い以上、そのログは絞り込める形でなければ意味がない。**構造化ログの唯一の入口は `src/observability/log.ts`** とし、経路を表す `op` を必ず付ける（`wrangler tail --search slack_webhook`）。経路ごとに `console.log` を直書きしないこと。フィールド名がドリフトすると、後から足した経路だけ絞り込みから漏れる。

**会話の本文はログに載せない。** 個人利用でも Workers Logs に残り続けるのは割に合わず、経路の確認にはイベントの種類と宛先で足りる。本文が要るデバッグはローカル（`bun run dev` + トンネル）で行う。
