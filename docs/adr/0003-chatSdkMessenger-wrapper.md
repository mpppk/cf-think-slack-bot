# Slackは chatSdkMessenger + @chat-adapter/slack で接続

Thinkに `slackMessenger()` ヘルパーが未公開（公開されているのはTelegram用のみ）のため、`chatSdkMessenger({ adapter: createSlackAdapter(...) })` にChat SDK公式のSlack adapterを渡して代替する。

```
provider: "slack"
userName: "cf-think-slack-bot"
respondTo: ["direct-message", "mention", "subscribed-thread"]
verifyWebhook: false   // adapter が signingSecret で検証する
```

webhookは `/messengers/slack/webhook`（Messenger keyを `slack` にした場合）。`respondTo` に `subscribed-thread` を含めないと「最初にmentionされたスレッドへの追記」に反応しない。
