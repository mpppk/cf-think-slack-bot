# Think Sessionを正典とする

Slack履歴を毎回 `conversations.replies` で再取得してLLM promptを再構築せず、Think Session（DO SQLite）をAI会話の正典とする。SlackはUI/配送履歴、ChatSDKはイベント/dedupe/streaming履歴として分離。ただし正典は完全なログではなく、compactionにより過去のtool_resultは非可逆に要約されうる。編集時にSessionを巻き戻す扱いは ADR 0005 を参照。
