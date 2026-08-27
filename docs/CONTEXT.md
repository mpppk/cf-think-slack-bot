# cf-think-slack-bot Context

Slack上で「最初だけ @bot、以降はスレッド内で自然に会話」するボットを Cloudflare Workers + Think + Chat SDK で提供するコンテキスト。

## Language

**Slack Thread**:
Slack UI上の会話の箱。`channel` と `thread_ts` で識別される、ユーザーが見る単位。
_Avoid_: Conversation, チャット

**ChatSDK Thread**:
SlackイベントをThinkへ配送する輸送層の識別子。`slack:{channel}:{thread_ts}` 形式の `thread.id`。
_Avoid_: Slack Thread, Session

**Think Session**:
Durable Object SQLiteに永続化されるLLM履歴。user/assistant/tool_result の順序、compaction、検索を持つ。
_Avoid_: Conversation, ChatSDK Thread, スレッド履歴

**Thread Agent**:
Slack Threadごとに1つ生成されるDurable Object。Think Sessionの永続化とagentic loopの実行を担う隔離単位。
_Avoid_: Sub-agent, Bot, Worker, Session

**Messenger**:
Thinkが外部チャットを接続する統合点。本プロジェクトでは `chatSdkMessenger({ adapter: createSlackAdapter(...) })`（ADR 0003）。
_Avoid_: Adapter, Bot

**Subscription**:
ChatSDKが「このChatSDK Threadの今後の `message` を配送する」と覚える購読。`app_mention` で作成され、解除されない限り継続する。
_Avoid_: Subscribe, フォロー

**Canonical History**:
AI会話の真実の源はThink Sessionであるという不変条件。SlackはUI/配送履歴、ChatSDKはイベント/dedupe/streaming履歴として分離する（ADR 0001）。
_Avoid_: Slack履歴, ChatSDK履歴

**Attachment**:
Slackに添付された画像。受け取り可能な形式と枚数の上限は ADR 0006。
_Avoid_: ファイル, 添付ファイル

**Compaction**:
Sessionがモデル上限に近づいたとき、古いtool_resultを要約してトークンを回収する操作。要約はoverlayとして保存され、元の行は検索から参照できる（ADR 0007）。
_Avoid_: 要約, 圧縮
