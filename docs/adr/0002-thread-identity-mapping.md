# Slack 1スレッド = ChatSDK 1 Thread = Think 1 Thread Agent

`thread.id = slack:{channel}:{thread_ts}` で1:1:1に束縛し、`Map<thread_ts, Conversation>` やD1 conversationテーブルの自前管理をしない。

このIDは自前で組み立てず、`@chat-adapter/slack` の `threadIdForMessageEvent()` / `encodeThreadId()` に委譲する（実装は `slack:${channel}:${threadTs}` を返し、本ADRの形式と一致する）。adapter側が「message / edit / delete が同じthreadに解決されること」を単一の責任箇所として保証しているため、こちらで `thread_ts ?? ts` を再実装すると解決先がずれる。

Slackの Agent messaging experience（manifestの `agent_view` モード）は**有効にしない**。有効にするとDMが「1メッセージ = 1スレッドルート」となり、DMで会話が continue しなくなる。無効時は `threadTs` が空文字となり、DMチャンネル全体が1 Threadに畳まれる。

## Considered Options

- **`agent_view` を有効化する**: Slackのアシスタント専用UI（サイドパネル、suggested prompts）が使えるようになるが、「最初だけ @bot、以降はスレッド内で自然に会話」という本プロジェクトの目的に対してDMの連続性を失う代償が大きい。
