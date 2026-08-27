# Slackイベントの重複排除・自己イベント除外は adapter に委譲する

Slack Events APIは3秒以内に200が返らないとリトライし（`x-slack-retry-num`）、bot自身の投稿やunfurlも `message` / `message_changed` として戻ってくる。これらの除外を自前実装せず、`@chat-adapter/slack` の既存実装に委譲する。

委譲先（v4.38.1時点で確認済み）:

- **リトライ重複**: `markEventDelivered()` / `isDuplicateEventDelivery()` が `event_id` をキーに配送済みを記録し、`retry_num > 0` のときだけ照会する
- **unfurlによる幽霊編集**: `message_changed` のうち `hidden === true` かつ本文・`edited.ts` に変化が無いものを破棄する
- **無変更の編集**: `previous_message` と本文が同一の `message_changed` を破棄する（ストリーミング更新もここで落ちる）
- **tombstone**: `subtype === "tombstone"` を破棄する
- **話者判定**: `MessengerAuthor` が `isMe` / `isBot` を持つ

自前で同じ判定を書かないこと。二重に実装するとadapter側の更新で挙動が食い違う。adapterのバージョンを上げる際はこの一覧が保たれているかを確認する。
