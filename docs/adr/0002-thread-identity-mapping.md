# Slack 1スレッド = ChatSDK 1 Thread = Think 1 Sub-agent

`thread.id = slack:{channel}:{thread_ts}` で1:1:1に束縛し、`Map<thread_ts, Conversation>` やD1 conversationテーブルの自前管理をしない。

このIDは自前で組み立てず、`@chat-adapter/slack` の `threadIdForMessageEvent()` / `encodeThreadId()` に委譲する（実装は `slack:${channel}:${threadTs}` を返し、本ADRの形式と一致する）。adapter側が「message / edit / delete が同じthreadに解決されること」を単一の責任箇所として保証しているため、こちらで `thread_ts ?? ts` を再実装すると編集イベントが別threadへ飛ぶ。

DMでは（`agentView` 無効時）`threadTs` が空文字となり、DMチャンネル全体で1 Threadに畳まれる。
