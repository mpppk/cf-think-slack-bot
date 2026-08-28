# デプロイは GitHub Actions から行い、Cloudflare Workers Builds は採らない

`wrangler deploy` は GitHub Actions のワークフローから実行する。リポジトリをCloudflareに接続して Cloudflare 側でビルド・デプロイさせる **Workers Builds は採用しない**。

Workers Builds の利点は「`CLOUDFLARE_API_TOKEN` を GitHub に置かなくて済む」ことで、これは実在する利点である。それでも採らないのは、この構成では次の3つが噛み合わないため。

## Considered Options

- **Workers Builds**: トリガーは Worker あたり最大2つ（production ブランチ / それ以外）で、フィルタは**ブランチとパスのパターンのみ**。GitHubのラベルは見られないので、ADR 0020 のラベル制プレビューが実現できない。また Actions のチェック結果を待たないため、「workerdテストの成功をゲートにする」には deploy command 側にもテストを書くことになり、テストが二重に走るうえゲートの所在がダッシュボードに隠れる。build/deploy command は**ダッシュボードにしか保存されずリポジトリで追えない**（同じ構成の wine では、そのせいで bun のバージョンが `packageManager` とビルド環境変数の2箇所管理になっている）。DO Worker ではプレビューURLもPRコメントも出ないので、Workers Builds の目玉機能はそもそも効かない。
- **Deploy Hooks（Actions からCloudflareのビルドを発火）**: Deploy Hook は**特定のブランチに固定されたURL**なので、ブランチ名が毎回変わるPRのプレビューには使えない。任意ブランチを指定するには Builds API を叩くことになり、結局APIトークンが要る。複雑さに見合わない。
- **wine と同じにする**: wine が Workers Builds を選んだ主因は「ビルド成功後・デプロイ直前に D1 マイグレーションを適用する」ためだが、このボットは DO SQLite で、その工程が存在しない。

## Consequences

- `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を GitHub に置く。リスクは**スコープと GitHub Environments で絞る**: トークンは対象アカウントの Workers Scripts:Edit のみ、Environment secret にしてデプロイジョブ以外からは読めなくする。
- デプロイの成否とログが GitHub 側に集まる。Cloudflare のダッシュボードにビルド履歴は残らない。
- ビルド環境（bunのバージョン等）の指定はワークフローYAMLに現れ、`packageManager` を唯一の真実の源にできる。
