# preview / production の2環境を workers.dev 上に置き、CIから自動デプロイする

Worker環境は preview と production の2つ。独自ドメインは用意せず `workers.dev`（`cf-think-slack-bot.niboshi.workers.dev` / `cf-think-slack-bot-preview.niboshi.workers.dev`）を使う。

デプロイはCIから自動で行う。main への merge で production へ、**`deploy-preview` ラベルが付いたPR**で preview へデプロイし、どちらも workerd テスト（ADR 0022）の成功をゲートにする。デプロイ手段に Cloudflare Workers Builds を採らない理由は ADR 0024。

検証はどちらの環境も同一Slackワークスペース（README参照）の別チャンネルで行う。

## プレビューがブランチごとではなくラベル制な理由

**Durable Object を実装した Worker には、Cloudflare が per-version のプレビューURLを発行しない**（[Preview URLs の Limitations](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/#limitations)）。Thread Agent が DO である以上、`wrangler versions upload` でPRごとのURLを得る道は最初から無い。仮にあっても Slack App の Request URL は1つしか持てないので、可変URLは叩けない。

したがってプレビューは**固定URLの Worker 1本**で、複数のPRが同時にデプロイすれば後勝ちになる。「今どのPRの内容が乗っているか」が分からない状態を避けるため、占有を `deploy-preview` ラベルで表明し、**ラベルが2本以上のPRに付いていたらデプロイせずCIを落とす**（表明とデプロイがズレないよう、排他は運用ではなくワークフローで機械的に保証する）。ラベルを外したPRはプレビューを手放し、CIがプレビューを main の内容へ戻す。

## Consequences

- Slack App は Event Subscriptions の Request URL をアプリあたり1つしか持てないため、**2環境をSlackから叩くには Slack App も2つ必要**になる（`cf-think-slack-bot` と `cf-think-slack-bot-preview`）。トークン・Signing Secret・botユーザーがそれぞれ別になり、secretも2組、manifestも2つ（ADR 0023）管理することになる。同一ワークスペースにbotが2体並ぶ。
- プレビューで検証できるPRは**同時に1本**。並行して2本のPRを実機確認することはできない。
