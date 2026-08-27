# 返信はストリーミングで逐次更新する

Slackへの返信は一括投稿ではなく、Chat SDKのSlack streaming（`chat.update` による逐次更新）で行う。LLMの初回トークンまでの待ち時間が長く、無反応に見える時間を作らないため。

逐次更新は自分の投稿に対する `message_changed` を発生させるが、adapterが本文の変わらない `message_changed` を破棄するため、こちらでの対処は不要（ADR 0021）。
