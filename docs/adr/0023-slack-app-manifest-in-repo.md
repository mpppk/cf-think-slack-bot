# Slack App manifest をリポジトリで管理する

Slack App の設定（bot_events、OAuthスコープ、Request URL、表示名）は Slack の管理画面だけで持たず、manifest をリポジトリに置く。preview / production で App が別になる（ADR 0020）ため manifest も2つ持つ。

Slack管理画面での設定はどこにも履歴が残らず、スコープの過不足が実行時エラーとしてしか現れない。実際に `files:read` の欠落は「ファイル本体ではなくHTMLのログインページが返る」という分かりにくい形で出る（ADR 0006）。差分で追える場所に置いておく。

## Consequences

manifest の適用自体は手動（Slackの管理画面へ貼るか App Manifest API を叩く）で、リポジトリの内容とSlack側の実状態が自動では同期しない。ズレうることを前提に、スコープを増やしたときは両方を更新する。
