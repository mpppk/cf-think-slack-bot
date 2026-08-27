# Slackは chatSdkMessenger + @chat-adapter/slack で接続

Thinkに `slackMessenger()` が未公開のため `chatSdkMessenger({ adapter: createSlackAdapter(...) })` で代替。`verifyWebhook:false`（adapter側でSigning Secret検証）、`provider:"slack" userName:"cf-think-slack-bot" respondTo:["direct-message","mention","subscribed-thread"]`、webhookは `/messengers/slack/webhook`。
