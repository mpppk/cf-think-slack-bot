# Think Sessionを正典とする

Slack履歴を毎回 `conversations.replies` で再取得してLLM promptを再構築せず、Think Session（DO SQLite）をAI会話の正典とする。SlackはUI/配送履歴、ChatSDKはイベント/dedupe/streaming履歴として分離する。

正典は「Slackの現在の表示内容」とは一致しない。Slack上で発言が編集・削除されてもSessionは投稿時点の内容を保つ（ADR 0005）。またモデルに渡る履歴はcompactionによって古いtool_resultが要約に置き換わる（ADR 0007）。
