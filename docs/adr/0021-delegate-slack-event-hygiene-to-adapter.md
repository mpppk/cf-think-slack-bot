# Slackイベントの重複排除・自己イベント除外は adapter に委譲する

Slack Events APIは3秒以内に200が返らないとリトライし（`x-slack-retry-num`）、bot自身の投稿やunfurlも `message` / `message_changed` として戻ってくる。これらの除外を自前実装せず、`@chat-adapter/slack` の既存実装に委譲する。

委譲先（v4.38.1時点で確認済み）:

- **リトライ重複**: `markEventDelivered()` / `isDuplicateEventDelivery()` が `event_id` をキーに配送済みを記録し、`retry_num > 0` のときだけ照会する
- **unfurlによる幽霊編集**: `message_changed` のうち `hidden === true` かつ本文・`edited.ts` に変化が無いものを破棄する
- **無変更の編集**: `previous_message` と本文が同一の `message_changed` を破棄する（ストリーミング更新もここで落ちる）
- **tombstone**: `subtype === "tombstone"` を破棄する
- **話者判定**: `MessengerAuthor` が `isMe` / `isBot` を持つ

自前で同じ判定を書かないこと。二重に実装するとadapter側の更新で挙動が食い違う。adapterのバージョンを上げる際はこの一覧が保たれているかを確認する。

## 例外: 添付のダウンロードは自前実装する

`@chat-adapter/shared` の `downloadAttachment()` は `node:dns` / `node:https` / `node:zlib` / `node:stream` に依存しており、Cloudflare Workers (workerd) では原理的に動かない（`NetworkError: Failed to fetch Slack file`）。そのため添付のダウンロードだけは委譲せず、素の `fetch` で自前実装する（`src/slack/fetch-slack-file.ts`）。`fetchMetadata.url` と `SLACK_BOT_TOKEN` は揃っているので `fetch` で取得できる。Cloudflare 公式の Slack agent サンプルも `@slack/web-api` を使わず素の `fetch` で Slack Web API を叩いており、同じ経路になる。

adapter の `protected createFileTransport()` は差し替え口として存在するが、返すべきものが Node の `IncomingMessage` 互換（`statusCode` / `headers` / `destroy()` / ストリーム）で、受け手の `readAttachmentBody()` も `stream.pipeline` / `zlib` を使うため、fetch で模倣するのは現実的でない。使わない。

自前実装は adapter が持っていた下記の保護を引き継ぐ。**手を抜くと SSRF の穴になる**ため省略しない:

- **Slack ホストに限定する。** 取得先ホストが `slack.com` / `slack-edge.com` / `slack-files.com` / `slack-files-gov.com` / `slack-gov.com`（サブドメイン含む）であることを検証する。任意 URL を取りに行かせない。`validateSlackUrl()` が `isAllowedSlackHost()` で判定する。
- **リダイレクト先が Slack ホストでなければ `Authorization` を送らない。** bot token は信頼できる Slack オリジン（`TRUSTED_SLACK_ORIGINS`）へのホップでのみ送る。リダイレクトは `redirect: "manual"` で手動追跡し、`isTrustedSlackOrigin()` で判定する。adapter の `fetchSlackFile()` が `isSlackAuthUrl()` で同じ判定をしている。
- **サイズ上限。** 事前の `filterAttachments`（10MB）に加え、読み取り時にも上限をかける。`content-length` は詐称されうるので、ストリームを読みながら累積バイト数で打ち切る（`FETCH_LIMIT_BYTES = 10MB`）。
- **リダイレクト回数の上限。** `FETCH_MAX_REDIRECTS = 5`（adapter の `REDIRECTS = 5` と同値）。超えたら `SlackFileTooManyRedirectsError`。
- **判定: `content-type` が `text/html` なら `files:read` スコープ不足。** adapter と同じく `SlackFileMissingScopeError` を投げ、`slack_attachment_missing_scope` としてログに残す。汎用エラーと区別する。

既存の修正は維持する:

- `768ab1e` — DOホップで `attachment.fetch` が失われる問題への対処と、解決できなかった場合の `logError`。
- `9a96b0f` — `fetchMetadata.teamId` を落として静的 `SLACK_BOT_TOKEN` へフォールバックさせる対処。単一ワークスペース構成（仕様§4.2）のため。自前実装では `teamId` を使わず静的 token で取得する。
