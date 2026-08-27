# preview / production の2環境を workers.dev 上に置き、CIから自動デプロイする

Worker環境は preview と production の2つ。独自ドメインは用意せず `workers.dev`（`cf-think-slack-bot.workers.dev`）を使う。デプロイはCIから自動で行う。

検証はどちらの環境も同一ワークスペース（ADR 0015）の別チャンネルで行うため、2環境は「別Slackワークスペース」ではなく「同一ワークスペース内の別チャンネル + 別Worker」を意味する。
