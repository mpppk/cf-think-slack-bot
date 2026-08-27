# 編集/削除は message.* の subtype として受け取る

編集/削除の巻き戻し（ADR 0005）に必要なイベントは、`bot_events` へ追加購読するものではない。Slackで購読できるのは `message.channels` / `message.groups` / `message.im` であり、編集・削除はその `subtype`（`message_changed` / `message_deleted`）として同じ購読で届く。したがってSlack App manifestの変更は不要で、必要なのはハンドラ側での `subtype` 分岐と、`message.ts` / `deleted_ts` による対象メッセージの特定である。

当初「`message_changed` / `message_deleted` を bot_events に追加する」と記録していたが、これはSlack Events APIに存在しない設定であり誤りだった。
