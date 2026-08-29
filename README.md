# cf-think-slack-bot

Slack上で「最初だけ `@bot`、以降はスレッド内で自然に会話」できるボット。Cloudflare Workers + [Think](https://www.npmjs.com/package/@cloudflare/think) + [Chat SDK](https://www.npmjs.com/package/@chat-adapter/slack) で構成する。

- ドメインモデルと用語: [docs/CONTEXT.md](docs/CONTEXT.md)
- 設計判断の記録: [docs/adr/](docs/adr/)
- 設計方針のIssue: [#1](https://github.com/mpppk/cf-think-slack-bot/issues/1)

## Slack App

- **ワークスペース**: `niboshiporipori.slack.com`。手動招待したチャンネルのみで動作し、DMは誰でも可
- **App は2つ**: `cf-think-slack-bot`（production）と `cf-think-slack-bot-preview`（preview）。Slack App は Request URL を1つしか持てないうえ、Durable Object を持つ Worker には Cloudflare が per-version の preview URL を発行しないため、環境分離には App 単位の固定 Request URL が必要（[ADR 0020](docs/adr/0020-two-environments-workers-dev.md)）。manifest は [`manifests/production.json`](manifests/production.json) / [`manifests/preview.json`](manifests/preview.json) でリポジトリ管理する（[ADR 0023](docs/adr/0023-slack-app-manifest-in-repo.md)）。**manifest の適用は手動**（Slack 管理画面へ貼り付け or App Manifest API）で、リポジトリと Slack 側の実状態は自動同期しない。スコープを増やしたときは両方を更新すること
- **表示名 / アイコン**: `cf-think-slack-bot`
- **bot_events**: `app_mention` / `message.channels` / `message.groups` / `message.im`
  - 編集・削除は独立したイベントではなく `message.*` の `subtype`（`message_changed` / `message_deleted`）として同じ購読で届く。ボットはこれらに追従しない（[ADR 0005](docs/adr/0005-no-edit-tracking.md)）
- **OAuth スコープ**:
  - `files:read` — 画像添付を読むために必要。無いとSlackがファイル本体ではなくHTMLのログインページを返す
  - `users:read` — chat-sdk が発言者名を引くために必要。無いと `missing_scope` で user info の取得に失敗し、チャンネルでの発言者ラベル（`名前: 本文`）が付かない（応答自体は続く）
  - **スコープを増やしたらワークスペースへの再インストールが必要**（manifestの貼り付けだけでは反映されない）
- **Agent messaging experience（`agent_view`）**: 使わない（[ADR 0002](docs/adr/0002-thread-identity-mapping.md)）
- **Webhook URL**（Event Subscriptions の Request URL）: **アカウントサブドメイン `niboshi` を必ず含める**。`<worker名>.workers.dev` としてしまうと別のホスト名になり、Slack が「The server couldn't be reached」で弾く。上記 manifest の `settings.event_subscriptions.request_url` と一致させること
  - production: `https://cf-think-slack-bot.niboshi.workers.dev/messengers/slack/webhook`
  - preview: `https://cf-think-slack-bot-preview.niboshi.workers.dev/messengers/slack/webhook`

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

デプロイ後は `scripts/smoke.sh` が外形から検証する。preview では**正しい署名の `url_verification` に challenge が返るところまで**確認するので、GitHub Secrets から Worker への secret 同期が実際に効いていることがここで分かる（[ADR 0025](docs/adr/0025-secrets-ssot-github.md)）。

**この検査は「GitHubに入れた値が Slack App の実物と一致しているか」までは見ない**（CIが同じ値で書き込み同じ値で署名するため）。実物との一致は、Slack App の Event Subscriptions に Request URL を登録して **Verified** になることでしか確認できない。デプロイ後に行うこと。

```bash
bun run smoke           # production
bun run smoke:preview   # preview（challenge まで。SLACK_SIGNING_SECRET が要る）
```

### リポジトリ側の設定（初回のみ手作業）

ワークフローが動くには次が必要。

1. **ラベル** `deploy-preview` を作る
2. **GitHub Environments** を2つ（`preview` / `production`）作り、下記を登録する。**Secrets と Variables で置き場所が違う**ので注意（ワークフローは `secrets.` / `vars.` で別々に参照する）
   - **Secrets**: `CLOUDFLARE_API_TOKEN` / `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `OPENROUTER_API_KEY` / `TAVILY_API_KEY`
   - **Variables**: `CLOUDFLARE_ACCOUNT_ID`（秘密ではないので Variables 側）
   - Slackの2つは環境ごとに別Appのもの（`preview` には preview App、`production` には production App）。残りは両環境で同じ値でよい
   - APIトークンの権限は **`Workers Scripts:Edit` 単体で足りる**（実機で確認済み。secretの同期もスクリプトのサブリソースなのでこれに含まれる）
3. **main のブランチ保護**: PR必須、`Type Check, Lint & Test` を required check に、force push 禁止

## 監視

Langfuse等のトレース基盤は使わず、Workers Logsのみ（[ADR 0018](docs/adr/0018-observability-logs-only.md)）。

```bash
bun run logs            # production
bun run logs:preview    # preview
```

`wrangler tail` はライブのみなので、後から追うぶんは `wrangler.jsonc` の `observability` で Workers Logs に保存している。

ログは `src/observability/log.ts` が唯一の入口で、経路を表す `op` が必ず付く。経路ごとに `console.log` を直書きしないこと（フィールド名がドリフトすると絞り込みが経路ごとに効かなくなる）。

```bash
bun run logs:preview -- --search slack_webhook
```

## Slack からの動作確認

**ボットが発言する実装が入るまで、Slack の画面上では何も起きない。** Webhook はイベントを受理して `202` を返すだけなので、届いていることを確認する手段は Workers Logs のログ1行になる。

```
{ op: 'slack_webhook', msg: 'イベントを受理した', payloadType: 'event_callback',
  eventId: 'Ev0PV52K21', teamId: 'T0001', eventType: 'app_mention',
  channelId: 'C0LAN2Q65', channelType: 'channel', userId: 'U061F7AUR',
  ts: '1515449522.000016', threadTs: '1515449522.000016' }
```

**メッセージ本文（`event.text`）は載せない。** 会話の中身が Workers Logs に残り続けるのを避けるためで、経路の確認には種類と宛先だけで足りる。本文が要るデバッグはローカルで行う。

デプロイ済みの preview で確認する手順:

1. Slack App `cf-think-slack-bot-preview` の Event Subscriptions で bot events を購読する（上記の `bot_events` 参照）
2. **ワークスペースに再インストールする**（イベントやスコープを足したら必須）
3. チャンネルにボットを招待する（`/invite @cf-think-slack-bot-preview`）
4. `bun run logs:preview` を流しながらメンションする

`401` が出たら署名の不一致。ログの `hasTimestamp` / `hasSignature` で切り分ける。両方 `true` なら Signing Secret の取り違え（その Slack App の値と GitHub Environment `preview` の `SLACK_SIGNING_SECRET` がズレている）、両方 `false` なら Slack 以外からのアクセス。

実装しながら回すならローカルの方が速い。上記「ローカル開発」のトンネルURLを preview App の Request URL に入れ替えると `console.log` が手元に出る。**終わったら Request URL を preview Worker に戻すこと**（戻し忘れると preview 環境が死んだままになる）。
