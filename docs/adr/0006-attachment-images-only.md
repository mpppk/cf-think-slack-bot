# 添付は画像のみ、10MB以下4枚まで、超過は無視して通知

jpeg/png/webp、1枚あたり10MB以下、1メッセージ4枚までをVisionでモデルへ渡す。非画像・5枚目以降・10MB超はSessionに保存せず、日本語で「画像以外は未対応」「4枚までです」「10MB超は未対応」と1行で通知する。

画像の取得は中間ストレージを介さず、Chat SDK の `attachment.fetchData()` に委譲する。この実装はSlackの `url_private` へ `Authorization: Bearer {token}` を付けて取得し、`rehydrateAttachment()` が `fetchMetadata.url` からDurable Objectのホップ後もダウンロード処理を再構築する。Sessionには `fetchMetadata.url` を残し、過去ターンの画像が必要になったら再取得する。

## Consequences

- Slack Appに `files:read` スコープが必要。無いとSlackがファイル本体ではなくHTMLのログインページを返し、adapterが `NetworkError` を投げる
- 画像の実体はSlackにあるため、ユーザーがSlack上でファイルを削除すると過去ターンの画像は再取得できなくなる。これは許容する
- HEIC（iOS標準）は許可リスト外で「画像以外は未対応」の扱いになる
