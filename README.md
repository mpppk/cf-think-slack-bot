# cf-think-slack-bot

Slack上で「最初だけ `@bot`、以降はスレッド内で自然に会話」できるボット。Cloudflare Workers + [Think](https://www.npmjs.com/package/@cloudflare/think) + [Chat SDK](https://www.npmjs.com/package/@chat-adapter/slack) で構成する。

- ドメインモデルと用語: [docs/CONTEXT.md](docs/CONTEXT.md)
- 設計判断の記録: [docs/adr/](docs/adr/)
- 設計方針のIssue: [#1](https://github.com/mpppk/cf-think-slack-bot/issues/1)

## Slack App

- **ワークスペース**: `niboshiporipori.slack.com`。手動招待したチャンネルのみで動作し、DMは誰でも可
- **App は2つ**: `cf-think-slack-bot`（production）と `cf-think-slack-bot-preview`（preview）。Slack App は Request URL を1つしか持てないため環境ごとに分ける（[ADR 0020](docs/adr/0020-two-environments-workers-dev.md)）。manifest はリポジトリ管理（[ADR 0023](docs/adr/0023-slack-app-manifest-in-repo.md)）
- **表示名 / アイコン**: `cf-think-slack-bot`
- **bot_events**: `app_mention` / `message.channels` / `message.groups` / `message.im`
  - 編集・削除は独立したイベントではなく `message.*` の `subtype`（`message_changed` / `message_deleted`）として同じ購読で届く。ボットはこれらに追従しない（[ADR 0005](docs/adr/0005-no-edit-tracking.md)）
- **OAuth スコープ**: 画像添付を読むために `files:read` が必要。無いとSlackがファイル本体ではなくHTMLのログインページを返す
- **Agent messaging experience（`agent_view`）**: 使わない（[ADR 0002](docs/adr/0002-thread-identity-mapping.md)）
- **Webhook URL**: `https://{worker}/messengers/slack/webhook`

## Secret / 環境変数

本番は `wrangler secret put`、ローカルは `.dev.vars`。

```bash
wrangler secret put SLACK_BOT_TOKEN
```

必要なもの: `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `OPENROUTER_API_KEY` / `TAVILY_API_KEY`。Slack の2つは環境ごとに別のAppのものを設定する。

OpenRouterアカウント側でクレジット上限を設定しておくこと。コード側にレート制限とコスト上限は意図的に実装していない（[ADR 0004](docs/adr/0004-openrouter-fixed.md)）。

## ローカル開発

```bash
bun run dev
```

別ターミナルでトンネルを張り、そのURLをSlack AppのWebhook URLに設定する（[ADR 0019](docs/adr/0019-local-dev-cloudflare-tunnel.md)）。

```bash
cloudflared tunnel --url http://localhost:8787
```

## テスト

workerd実環境で走らせる（[ADR 0022](docs/adr/0022-tests-on-workerd.md)）。テストファイルは `*.workers.test.ts` に置く。

```bash
bun run test
```

## デプロイ

PR を開くと preview へ、main への merge で production へ CI が自動デプロイする。どちらも workerd テストの成功がゲート（[ADR 0020](docs/adr/0020-two-environments-workers-dev.md)）。

## 監視

Langfuse等のトレース基盤は使わず、Workers Logsのみ（[ADR 0018](docs/adr/0018-observability-logs-only.md)）。

```bash
bun run logs
```
