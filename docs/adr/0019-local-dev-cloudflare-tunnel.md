# ローカル開発は Cloudflare Tunnel、Socket Mode は不採用

ローカル開発では `cloudflared tunnel --url localhost:8787` でWebhookを受ける。

Slack botの一般的な開発手法である Socket Mode は採用しない。Socket ModeはSlackとの常時WebSocket接続を前提とするが、Cloudflare Workersはリクエスト単位で起動しコネクションを保持し続けられないため、本番構成と乖離した開発環境になる。ngrokではなくCloudflare Tunnelを選ぶのは、デプロイ先と同じ事業者のツールで完結させるため。
