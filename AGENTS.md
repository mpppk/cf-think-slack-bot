# AGENTS.md

このリポジトリでエージェントが作業するときの注意点。**踏むと気づきにくい落とし穴**だけを書く。設計判断の理由は [docs/adr/](docs/adr/)、用語は [docs/CONTEXT.md](docs/CONTEXT.md)、運用手順は [README](README.md) にある。

## 仕様の正はどこか

**仕様の正は [Issue #23](https://github.com/mpppk/cf-think-slack-bot/issues/23)。**

- `docs/SPEC.md` は #23 本文が「リポジトリ側の正」と書いているが、**実際には存在しない**。参照しないこと
- README は設計方針として [#1](https://github.com/mpppk/cf-think-slack-bot/issues/1) を指しているが、**#1 は #23 に置き換えられている**。#1 の記載のうち9項目はその後の調査で覆っており、対比表が #23 の末尾にある
- 実装範囲と依存関係の正は **#23 の §9 実装状況テーブル**

### sub issue の本文の「対象仕様」はずれている

**sub issue のタイトルは正しいが、本文の「対象仕様」の節番号は1つずれている。** `gh issue view <N>` の本文を信用して実装範囲を決めないこと。

| Issue | タイトル（正しい） | 本文の「対象仕様」（ずれている） |
|---|---|---|
| #28 | configureSession() へのcompaction登録 | §3.4 添付 ← #29 の内容 |
| #29 | 画像添付の受け取りと上限超過時の通知 | §3.6 ツール ← #30 の内容 |
| #30 | Tavily検索ツールとfetchツールの有効化 | §3.8 失敗時 ← #31 の内容 |
| #31 | 生成失敗時の通知をallowlist方式で分類する | §4.2 Slack App ← #32 の内容 |

タイトルと #23 §9 テーブルを正として扱う。2026-08-29 時点で確認。

## コードの落とし穴

### `src/index.ts` の named export はハンドラとDOクラスのみ

定数を export すると **workerd が起動しなくなる**。しかも `typecheck` / `vitest` / `wrangler deploy --dry-run` は**全部通ってしまう**ので、CI をすり抜けて本番で初めて壊れる（仕様§5.1）。

### シークレット名は3箇所を同期する

`src/env-secrets.d.ts` / `.dev.vars.example` / `.github/workflows/ci.yml` の3箇所に現れる。ズレは `bun run check:conventions` が検出する。

シークレットの**正は GitHub Environments の Secrets**（`preview` / `production`）で、デプロイジョブが `wrangler secret bulk` で Worker へ同期する。Worker 側は導出物なので `wrangler secret put` を手で叩かない（[ADR 0025](docs/adr/0025-secrets-ssot-github.md)）。

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
