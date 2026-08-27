# cf-think-slack-bot Context

Slack上で「最初だけ @bot、以降はスレッド内で自然に会話」するボットを Cloudflare Workers + Think + Chat SDK で提供するコンテキスト。
## Language

### Slack Thread
Slack UI上の会話の箱。`channel` と `thread_ts` で識別される。ユーザーが見る単位。
_Avoid_: Conversation, チャット

### ChatSDK Thread
配送の識別子。`slack:{channel}:{thread_ts}` 形式の `thread.id`。SlackイベントをThinkへ配送する輸送層のID。
_Avoid_: Slack Thread, Session

### Think Session
DO SQLite上に永続化されるLLM履歴の正典。user/assistant/tool_result の順序と compaction/search を持つ。Slackの編集があっても正典はここ。
_Avoid_: Conversation, ChatSDK Thread, スレッド履歴

### Sub-agent
`Think Session` ごとに生成されるDurable Objectの実行隔離単位。`slack:{channel}:{thread_ts}` ごとに1つ。リカバリとagentic loopを担当。
_Avoid_: Bot, Worker, Session

### Messenger
Thinkが外部チャットを接続する統合点。`slack = chatSdkMessenger({ adapter: slack, provider:"slack", userName:"cf-think-slack-bot", respondTo: [...] })`。
_Avoid_: Adapter, Bot

### Subscription
ChatSDKが「このChatSDK Threadの今後の `message` を配送する」と覚える購読。`app_mention` で作成され `subscribed-thread` で継続。90日無通信で購読のみ解除。
_Avoid_: Subscribe, フォロー

### Canonical History
AI会話の真実の源は Think Session であるという不変条件。Slackは配送/UI履歴、ChatSDKはイベント/dedupe/streaming履歴。
_Avoid_: Slack履歴, ChatSDK履歴


### Edit
Slackの `message_changed` / `message_deleted` で届く訂正。Sessionでは直前user発言を新内容で置換（削除は1往復削除）し再生成する。
_Avoid_: 訂正メッセージ, 再送

### Attachment
Slackに添付された画像。jpeg/png/webp、10MB以下、1メッセージ4枚までをVisionでLLMへ渡し、超過は無視して日本語で「4枚までです」「10MB超は未対応」と通知しSessionに保存しない。
_Avoid_: ファイル, 添付ファイル

### Compaction
Sessionがモデル上限に近づいたとき古いtool_resultを要約してトークンを回収する操作。Web検索結果は永続だが上限超えで自動要約される。
_Avoid_: 要約, 圧縮

### Idle
Subscriptionの無通信期間。最終Slackメッセージから90日で購読のみ解除、Sessionは保持。スレッド内の誰かの新メッセージで自動再購読。
_Avoid_: TTL, タイムアウト

### Failure Notice
LLM/OpenRouter失敗時にスレッドへ返す詳細エラー表示。dedupeはサイレント、429/5xxは詳細（code/message）を日本語とともに表示。
_Avoid_: エラーメッセージ, 例外

### Bot Event
SlackがWorkerへ送るイベント種別。`app_mention` / `message.channels` / `message.groups` / `message.im` を購読する。編集・削除は独立したイベントではなく `message.*` の `subtype`（`message_changed` / `message_deleted`）として同じ購読で届く。
_Avoid_: Event, webhook

### R2 Image Store
編集や添付で受領した画像を一時保存するR2バケット。4枚/10MBルールの前処理とVisionへの受け渡しに使う。
_Avoid_: ストレージ, バケット

### R2 Retention
R2に一時保存した画像はVisionへ渡した直後に削除する。Sessionは無期限だがR2は一時的。
_Avoid_: 保持期間, 削除ポリシー

### Compaction Trigger
Session上限超え時の要約はThinkデフォルトのcompactionに委譲し、閾値はThink任せとする。
_Avoid_: 閾値, 自前要約
