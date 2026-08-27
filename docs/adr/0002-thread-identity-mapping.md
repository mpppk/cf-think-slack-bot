# Slack 1スレッド = ChatSDK 1 Thread = Think 1 Sub-agent

`thread.id = slack:{channel}:{thread_ts}` で1:1:1に束縛。`Map<thread_ts, Conversation>` やD1 conversationテーブルの自前管理をしない。ラウンド1 Q1で用語を4分離（Slack Thread/ChatSDK Thread/Think Session/Sub-agent）し、Q3で購読は90日アイドルで解除・Sessionは保持と決めた。
