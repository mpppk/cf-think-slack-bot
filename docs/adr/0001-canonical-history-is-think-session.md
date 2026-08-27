# Think Sessionを正典とする

Slack履歴を毎回 `conversations.replies` で再取得してLLM promptを再構築せず、Think Session（DO SQLite）をAI会話の正典とする。SlackはUI/配送履歴、ChatSDKはイベント/dedupe/streaming履歴として分離。ラウンド1 Q2で編集時は巻き戻す例外を追加したが、正典は依然Sessionである。
