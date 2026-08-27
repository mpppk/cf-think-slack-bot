# テストは workerd 実環境で走らせる

テストは vitest の `workers` プロジェクト（workerd + miniflare）で `*.workers.test.ts` として書く。node環境 + mockでは走らせない。

検証したいものがWebhook署名検証とthread分離であり、どちらも実行環境そのものに依存するため。署名検証はWeb Crypto APIの挙動に、thread分離はDurable Objectのインスタンス境界に依存し、nodeのmockで再現すると「mockが正しいこと」をテストするだけになる。

## Consequences

テストの起動はnode環境より遅く、workerdで動かない開発ツール（一部のカバレッジツール等）は使えない。実行手順とファイル命名規則は README に置く。
