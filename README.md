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

必要なもの: `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `OPENROUTER_API_KEY` / `TAVILY_API_KEY`。Slack の2つは環境ごとに別のAppのものを設定する。

**デプロイ済み環境のsecretは手で入れない。** 正は GitHub Environments（`preview` / `production`）のSecretで、CIがデプロイ前に `wrangler secret bulk` で Worker へ同期する（[ADR 0025](docs/adr/0025-secrets-ssot-github.md)）。ローカルは `.dev.vars`（`.dev.vars.example` をコピー）。

シークレット名は宣言（`src/env-secrets.d.ts`）・ローカル（`.dev.vars.example`）・CIの同期（`.github/workflows/ci.yml`）の3箇所に現れる。ズレは `bun run check:conventions` が落とす。

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

## CI

`.github/workflows/ci.yml` の1本にCIとデプロイが入っている。ローカルでCIと同じことを回すには:

```bash
bun run check:conventions   # シークレット名の3箇所一致・テストの命名規約
bun run check:types         # worker-configuration.d.ts の鮮度（wrangler.jsonc との突合）
bun run typecheck
bun run check               # Biome (lint + format)
bun run test                # workerd
bun run check:deploy        # wrangler deploy --dry-run（production / preview）
bun run check:deploy:preview
```

生成物を更新するのは `bun run cf-typegen`（バインディングやvarsを足したら実行してコミットする）。

## デプロイ

CIが自動で行う（[ADR 0024](docs/adr/0024-deploy-from-github-actions.md)）。どちらも workerd テストの成功がゲート。

| きっかけ | 行き先 |
|---|---|
| main への merge | production（`cf-think-slack-bot`） |
| PR に `deploy-preview` ラベルを付ける | preview（`cf-think-slack-bot-preview`） |

**プレビューは同時に1本のPRしか使えない。** Durable Object を持つ Worker にはPRごとのプレビューURLが発行されず（Cloudflareの制約）、Slack App の Request URL も1つしか持てないため、preview は固定URLの Worker 1本になる。ラベルが2本以上のPRに付いているとCIが落ちる（[ADR 0020](docs/adr/0020-two-environments-workers-dev.md)）。ラベルを外すと preview は main の内容に戻る。

デプロイ後は `scripts/smoke.sh` が外形から検証する。preview では**正しい署名の `url_verification` に challenge が返るところまで**確認するので、Worker に配られた signing secret が preview Slack App の実物と一致していることがここで分かる（[ADR 0025](docs/adr/0025-secrets-ssot-github.md)）。

```bash
bun run smoke           # production
bun run smoke:preview   # preview（challenge まで。SLACK_SIGNING_SECRET が要る）
```

### リポジトリ側の設定（初回のみ手作業）

ワークフローが動くには次が必要。

1. **ラベル** `deploy-preview` を作る
2. **GitHub Environments** を2つ作り、Secretを登録する
   - `preview`: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `OPENROUTER_API_KEY` / `TAVILY_API_KEY`（Slackの2つは **preview App** のもの）
   - `production`: 同じ名前で、Slackの2つは **production App** のもの
   - APIトークンは "Edit Cloudflare Workers" 相当（対象アカウントの Workers Scripts:Edit）
3. **main のブランチ保護**: PR必須、`Type Check, Lint & Test` を required check に、force push 禁止

## 監視

Langfuse等のトレース基盤は使わず、Workers Logsのみ（[ADR 0018](docs/adr/0018-observability-logs-only.md)）。

```bash
bun run logs            # production
bun run logs:preview    # preview
```

`wrangler tail` はライブのみなので、後から追うぶんは `wrangler.jsonc` の `observability` で Workers Logs に保存している。
