# 編集・削除には追従しない

Slackの `message_changed` / `message_deleted` には追従せず、Think Session は投稿時点の内容を正典とする。ユーザーがSlack上でメッセージを編集・削除しても、Sessionの履歴と以降の応答は変化しない。

当初は「編集は直前user発言を新内容で置換して再生成、削除は1往復削除」と決めていたが、`@cloudflare/think@0.16.0` の実装を確認して撤回した。

## 撤回の理由

編集を反映するための部品は揃っている。Chat SDKは `chat.onMessageUpdated` / `chat.onMessageDeleted` を公開しており、Slack adapterは `processMessageUpdated()` まで正しく流している。Think の Session も `updateMessage()` / `deleteMessages()` を持ち、`appendMessage(message, parentId)` はidを呼び出し側が指定できるため、Slackの `ts` をmessage idに採用すればメッセージ同一性も解決できる。

成立しないのは接続部分である。Think の `chatSdkMessenger` が購読しているのは `onDirectMessage` / `onNewMention` / `onSubscribedMessage` / `onAction` の4つだけで、`MessengerEventKind` にも編集・削除に相当する種別が無い。そして `ThinkMessengerRuntime` の `chat` フィールドは private であり、外部から `onMessageUpdated` を追加できない。

実装するには chatSdkMessenger の外に自前の `Chat` を立てるか private フィールドに触る必要があり、どちらもThinkの更新で静かに壊れる。壊れたことを検知する手段も無い。Slackの編集の大半はtypo修正で再生成の価値が小さいのに対し、コストは「Thinkの内部実装に追従し続ける」で最大級になる。

## Consequences

- ユーザーがSlack上で発言を編集しても、ボットは古い内容を前提に応答し続ける。これは仕様であり、必要なら新しいメッセージとして投稿し直してもらう
- adapterは編集イベント自体は流し続けるが、Think側で消費されずに終わる
- 画像の差し替えにも追従しない（ADR 0006）
