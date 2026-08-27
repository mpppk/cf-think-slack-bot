# compaction は configureSession() で登録する

ツールのtool_result（ADR 0017）はSessionに永続するが、モデル上限に近づいたら古いtool_resultから要約してトークンを回収する。要約は単純削除ではなくLLMによる要約とし、`addCompaction()` でoverlayとして保存する。閾値と要約関数は `configureSession()` で `onCompaction()` + `compactAfter(threshold)` として明示的に登録する。

当初は「Thinkのデフォルトcompactionに委譲し、自前実装しない」と決めていたが、これは事実に反していたため撤回した。

## デフォルトが存在しないという事実

`@cloudflare/think@0.16.0` の `Think.configureSession(session)` の既定実装は `return session` のみで、compactionは何も登録されない。Session の `compactAfter(threshold)` は型定義に「Requires `onCompaction()`」と明記されており、`session.compact()` は「登録されたcompaction関数を実行する」ため未登録ならnullを返す。

その結果 Think の `compactForContextOverflow()` は `shortened = false` となり、`classification: "context_overflow"` のエラーとして終了する。つまり登録しなければ、長いスレッドは要約されずに失敗する。

## Consequences

- compactionは非可逆ではない。要約はoverlayとして保存され、元の行はSQLiteに残るため `session.search()`（FTS5）からは引き続き参照できる。モデルに渡る履歴からは隠れる
- 要約にはLLM呼び出しが発生するが、compactionが走るのはまれなので追加コストは小さい
- 閾値をこちらで決める以上、モデルを差し替える際（ADR 0004）はコンテキスト長に合わせて見直すこと
