# 観測性は Workers Logs のみ、Langfuse は不採用

監視は Workers Logs / Tail のみとする。Langfuse連携（`withSpan` / `finishMeteredInference` / `ctx.recordGeneration()`）は個人利用のボットに対して運用コストが見合わないため採用しない。

トレース基盤を後から入れたくなった場合に再検討する余地はあるが、「まだ入れていない」のではなく「意図的に入れていない」ことを記録しておく。
