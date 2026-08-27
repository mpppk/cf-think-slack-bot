# preview / production の2環境を workers.dev 上に置き、CIから自動デプロイする

Worker環境は preview と production の2つ。独自ドメインは用意せず `workers.dev`（`cf-think-slack-bot.workers.dev`）を使う。

デプロイはCIから自動で行う。PRを開くと preview へ、main への merge で production へデプロイし、どちらも workerd テスト（ADR 0022）の成功をゲートにする。

検証はどちらの環境も同一Slackワークスペース（README参照）の別チャンネルで行う。

## Consequences

Slack App は Event Subscriptions の Request URL をアプリあたり1つしか持てないため、**2環境をSlackから叩くには Slack App も2つ必要**になる（`cf-think-slack-bot` と `cf-think-slack-bot-preview`）。トークン・Signing Secret・botユーザーがそれぞれ別になり、secretも2組、manifestも2つ（ADR 0023）管理することになる。同一ワークスペースにbotが2体並ぶ。
