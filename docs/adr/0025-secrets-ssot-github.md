# シークレットの正は GitHub Secrets に置き、CIが Worker へ同期する

`SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` / `OPENROUTER_API_KEY` / `TAVILY_API_KEY` の正は GitHub Secrets（Environment 単位）に置く。デプロイジョブが `wrangler secret bulk` で Worker へ流し込むので、**Worker 側のシークレットは導出物**であり、`wrangler secret put` を手で叩く運用はしない。

手で置くと、preview の signing secret は「Slack管理画面 / Worker / GitHub」の3箇所に散る。rotate のたびに3箇所を更新することになり、ズレたときの症状が**「CIは緑・デプロイは成功・Slackからは 401」**という一番切り分けにくい形になる。正を1つにすれば更新箇所は Slack と GitHub の2つに減る。

CIに書き込み権限を与えることになるが、デプロイ用のAPIトークンは元々 Workers Scripts:Edit を持ち、それがあればシークレットは書き換えられる。実質的なリスクは増えない。

## スモークで challenge まで通すのは preview だけ

Slack の Signing Secret は **App ごとに1つで、用途別の追加発行はできない**（管理画面の Regenerate は置換であって追加ではない）。したがって「テスト専用のsecret」は作れない。

作れるのは**テスト専用の App** で、それは ADR 0020 の `cf-think-slack-bot-preview` として既に存在する。preview App の signing secret が漏れてもなりすませるのは preview bot だけなので、これはCIに渡してよい。**production の signing secret はCIに渡さない**。結果として:

| | production | preview |
|---|---|---|
| `GET /health` | 実施 | 実施 |
| 署名なし → 401 | 実施 | 実施 |
| 正しい署名の `url_verification` → challenge エコー | **しない** | 実施 |

## 何をどこで検証するか

混同すると片方をサボる理由になるので、責務を分ける。

- **署名検証ロジックの正しさ**（改竄・期限切れ・ヘッダ欠落・別secret）は `*.workers.test.ts` が網羅する。任意の値をenvに注入すればよく、**実secretは要らない**。
- **デプロイ済み環境のsecretが Slack App の実物と一致しているか**は `scripts/smoke.sh --with-challenge` だけが分かる。`wrangler secret list` は名前しか返さないため、値の一致を見る手段が他に無い。

`--with-challenge` を指定して `SLACK_SIGNING_SECRET` が無い場合、スモークは**スキップせず失敗する**。「検査できなかった」が緑になると、この検査を持っている意味が消える。

## Consequences

- `OPENROUTER_API_KEY` / `TAVILY_API_KEY` も GitHub Secrets に置くことになる。
- シークレット名は「宣言（`src/env-secrets.d.ts`）/ ローカル（`.dev.vars.example`）/ CIの同期（`.github/workflows/ci.yml`）」の3箇所に現れる。ズレは `bun run check:conventions` が落とす。
- preview の signing secret を rotate したら、Slack と GitHub Environment の両方を更新する。片方だけだと次のスモークが落ちて気付ける。
