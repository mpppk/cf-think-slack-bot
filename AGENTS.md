# AGENTS.md

このリポジトリでエージェントが作業するときの注意点。**踏むと気づきにくい落とし穴**だけを書く。設計判断の理由は [docs/adr/](docs/adr/)、用語は [docs/CONTEXT.md](docs/CONTEXT.md)、運用手順は [README](README.md) にある。

## 仕様の正はどこか

**仕様の正は [Issue #23](https://github.com/mpppk/cf-think-slack-bot/issues/23)。**

- `docs/SPEC.md` は #23 本文が「リポジトリ側の正」と書いているが、**実際には存在しない**。参照しないこと
- README は設計方針として [#1](https://github.com/mpppk/cf-think-slack-bot/issues/1) を指しているが、**#1 は #23 に置き換えられている**。#1 の記載のうち9項目はその後の調査で覆っており、対比表が #23 の末尾にある
- 実装範囲と依存関係の正は **#23 の §9 実装状況テーブル**
- sub issue（#26〜#32）のタイトル・本文・依存は §9 テーブルと整合している。以前は本文が1つ後ろにずれていたが 2026-08-29 に修正済み

## コードの落とし穴

### `src/index.ts` の named export はハンドラとDOクラスのみ

定数を export すると **workerd が起動しなくなる**。しかも `typecheck` / `vitest` / `wrangler deploy --dry-run` は**全部通ってしまう**ので、CI をすり抜けて本番で初めて壊れる（仕様§5.1）。

### シークレット名は3箇所を同期する

`src/env-secrets.d.ts` / `.dev.vars.example` / `.github/workflows/ci.yml` の3箇所に現れる。ズレは `bun run check:conventions` が検出する。

シークレットの**正は GitHub Environments の Secrets**（`preview` / `production`）で、デプロイジョブが `wrangler secret bulk` で Worker へ同期する。Worker 側は導出物なので `wrangler secret put` を手で叩かない（[ADR 0025](docs/adr/0025-secrets-ssot-github.md)）。

### npm パッケージが `cache: "default"` を付けると workerd で必ず失敗する

**Workers が受け付ける `cache` は `no-store` と `no-cache` だけ**で、それ以外は `TypeError: Unsupported cache mode: <mode>` になる。axios の fetch アダプタは `cache: "default"` を既定値に持つため、**axios を使う npm パッケージは Workers 上でそのままでは動かない**。

このリポジトリでは `@chat-adapter/slack` → `@slack/web-api` → axios の経路で踏み、`src/slack/workerd-cache-patch.ts` で対処している。**触る前にそのファイルのコメントを読むこと。**

症状が分かりにくい。`WebClient` はこれを一時的な通信失敗として扱い**リトライを繰り返す**ので、例外が表に出ないまま処理がハングする。preview で bot がメンションに無反応になり、原因特定に時間がかかった。ログにはこう出る:

```
[chat-sdk:slack] ... [WARN] web-api:WebClient:0 http request failed
Unsupported cache mode: default
```

対処するときに踏んだ罠が3つあり、**どれか1つでも外すと直らない**:

1. **`fetch` だけ差し替えても効かない。** axios は `new Request(url, resolvedOptions)` を組んでから fetch へ渡すので、例外は `Request` のコンストラクタで起きる。`Request` と `fetch` の両方に当てる
2. **axios の設定では届かない。** axios は CJS と ESM の2ビルドを持ち、`@slack/web-api` は `require("axios")` で CJS 版、`import axios` は ESM 版を掴む。**別インスタンス**なので `axios.defaults.fetchOptions` を触っても Slack 側に効かない
3. **当てる順番が本質。** axios はアダプタ生成時に `globalThis.Request` をクロージャへ捕獲する。ESM は import が本体より先に評価されるため、`@chat-adapter/slack` を import しているモジュールの本体でパッチを呼んでも手遅れ。**エントリ（`src/index.ts`）の先頭で副作用 import する**

なお Cloudflare 公式の Slack agent サンプルは `@slack/web-api` を使わず素の `fetch` で Slack Web API を叩いており、この問題自体を踏まない。将来 adapter への委譲（[ADR 0003](docs/adr/0003-chatSdkMessenger-wrapper.md) / [ADR 0021](docs/adr/0021-delegate-slack-event-hygiene-to-adapter.md)）を見直すなら、その選択肢がある。

### Webhook は Think の完了を待ってはいけない

`src/slack/webhook.ts` は `ctx.waitUntil` で非同期に配送し、即 202 を返す（仕様§4.1「即座に ack を返し、実処理は非同期で行う」）。**これを「簡潔だから」と同期 `await` に戻さないこと。** Think の処理には LLM 呼び出しが含まれ3秒に収まらないため、Slack がリトライを繰り返し同じイベントが何度も配送される（実際に発生した）。

配送には25秒のタイムアウトを入れてある。**ハングしたまま invocation が終わらないと Workers Logs に何も出ず、原因調査ができなくなる**ため。

## CI / デプロイの落とし穴

### ローカルの `bun run smoke:preview` は必ず1件失敗する

`--with-challenge` に `SLACK_SIGNING_SECRET` が要るが、ローカルにはない（上記のとおり正は GitHub Environments）。**これは異常ではない。**

```
ok    GET /health -> 200
ok    POST /messengers/slack/webhook (署名なし) -> 401
ok    POST /messengers/slack/webhook (壊れた署名) -> 401
FAIL  --with-challenge が指定されましたが SLACK_SIGNING_SECRET がありません
```

challenge を含む完全な判定は **CI の Smoke test ジョブのログ**で行う（`gh run view <run_id> --job <job_id> --log`）。GitHub Secrets → Worker の同期が効いていれば 4 passed になる。

### `deploy-preview` ラベルは1つのPRしか占有できない

2本以上のPRに付いていると CI が落ちる。付ける前に確認する:

```bash
gh pr list --label deploy-preview --json number,url,title
```

### ラベル追加直後の「fail」は誤読しやすい

ラベルを付けると CI が再トリガーされ、**先行の run がキャンセルされて `fail` と表示される**。実体は下記のアノテーションで、待てば新しい run が成功する。慌てて調査しないこと。

```
Canceling since a higher priority waiting request for CI-refs/pull/<N>/merge exists
```

### スコープを増やしたら再インストールが要る

`manifests/*.json` を Slack 管理画面に貼り付けるだけでは**スコープ変更は反映されない**。OAuth & Permissions から **Reinstall to Workspace** が必要で、その際 `SLACK_BOT_TOKEN` が変わることがある（変わったら GitHub Environments の secret を更新する）。

スコープ不足は応答を止めるとは限らない。`users:read` が無いときは `missing_scope` をログに出しつつ応答自体は続き、チャンネルの発言者ラベル（`名前: 本文`）だけが落ちていた。**「動いているから足りている」とは判断できない**ので、ログを見ること。

### `Closes #A, #B` はカンマ区切りだと1件しか閉じない

GitHub は**各issue番号の前にキーワードが必要**。`Closes #26, #27, #28` と書くと **#26 しか閉じない**。実際に PR #33 でこれを踏み、6件中5件が開いたまま残った。

```
Closes #26, closes #27, closes #28   ← 各番号にキーワードを付ける
```

マージ後は `gh issue list --state open` で残っていないか確認する。

## 観測できないものは調査できない

このリポジトリで**同じ失敗を2回**踏んだ。どちらも「動いていないように見えるが、ログに手がかりが無い」状態を作り、原因特定に時間を溶かした。

- **添付の取得**: `att.fetch` が無いとき黙って `continue` していた。ログが無いので「画像を無視する bot」にしか見えない
- **Tavily 検索**: 自作ツールに出力が1行も無かった。Think のテレメトリ（`tool:fetch` など）は**組み込みツールにしか出ない**ので、呼ばれたかどうかすら分からなかった

**外部サービスを叩く箇所と、条件分岐で処理を打ち切る箇所には必ずログを置く。** 特に「何もせず抜ける」パスは、成功時と区別がつかないので優先度が高い。

ログに**本文・検索クエリ・ファイルURLは載せない**（会話の中身が Workers Logs に残り続けるため）。長さ・件数・分類・HTTPステータスだけで、経路の判定はできる。

## 複数エージェントで並行作業するとき

- **コミットの責任者を先に決める。** 2026-08-29 のオーケストレーションでは worker ごとにコミットしたりしなかったりで統一されず、**#28 と #31 が1コミットに混ざった**（`983d80a`）。issue単位のtraceabilityが失われる
- **同一worktreeで並行させるなら、同じファイルを触るタスクは論理依存がなくても直列化する。** DAGの依存関係はファイル競合を防がない。実際 #28 と #31 が同時に `src/slack/bot.ts` を編集し、「未完成のコードで typecheck が壊れる」というエスカレーションが発生した
- Orca orchestration を使う場合の既知の不具合と回復手順は [.agents/skills/orca-worker-dispatch/SKILL.md](.agents/skills/orca-worker-dispatch/SKILL.md) にまとめてある

## 受け入れ基準

```bash
bun run test              # workerd実環境（*.workers.test.ts）
bun run check:conventions # シークレット3箇所の一致とテスト命名規約
bun run check:types
bun run typecheck
bun run check
bun run check:deploy
```

自動では確かめられないもの（Slack App の Request URL が Verified になること、スレッド文脈の保持、DM、画像添付の上限通知）は #23 §8 の手動確認項目を参照。
