---
allowed-agents: claude-code
description: Orca orchestration で1人のコーディネーターが複数のworkerにタスクDAGを配って実装させるときの手順書。worker-startの起動フラグ制約、agent_prompt_stalledで dispatch capability が revoke されたときの回復手順、tui-idleが信用できない環境での完了検知、同一worktreeでのファイル競合の避け方を定める。「Orcaでworkerに並列実装させて」「orchestrationでDAGを回して」のように、コーディネーターとしてworkerを監督する指示を受けたときに使う。独立セッションがIssueを取り合う場合は issue-claim-protocol を使う。
name: orca-worker-dispatch
---

# orca-worker-dispatch

Orca orchestration で、**1人のコーディネーターがタスクDAGを複数のworkerへ配って実装させる**ときの手順書。

`issue-claim-protocol` とは前提が違う。あちらは「独立したセッションが早期Draft PRでIssueのclaimを取り合う」モデル、こちらは「1人のコーディネーターがTask/Dispatchを持ち、worker_doneを待つ」モデル。混ぜないこと。

コマンドの網羅的なリファレンスは `orca skills get orchestration` が返す（バイナリのバージョンに追従するので、記憶やこのファイルからフラグを推測しないこと）。**このファイルはそこに書かれていない実地の落とし穴だけを扱う。**

## When to use

- ユーザーが「監督して」「完了を待って」「DAGを回して」等、supervised な調整を明示的に求めたとき
- 逆に「hand off」「別のエージェントに渡して」だけなら full handoff であり、このskillは使わない（Task/Dispatchを作らない）

## 前提: worker-start は失敗する前提で組む

**Orca + opencode の組み合わせでは `worker-start` が `agent_prompt_stalled` で失敗する。** 2026-08-29 の実測（Orca 1.4.191 / OpenCode 1.18.25）で、**9 dispatch 中 9 件が失敗、受理された `worker_done` は 0 件**だった。

```json
{ "state": "failed", "stage": "dispatch_input", "lastError": "agent_prompt_stalled" }
```

重要なのは、**壊れているのは Orca 側のライフサイクル管理だけで、worker は正常に spec を受け取り最後まで実装を完遂する**こと。失敗の瞬間に dispatch capability が revoke され、以降その worker からの `worker_done` / `heartbeat` / `escalation` は全て拒否される。

有力な仮説は `--timeout-ms` の既定値60秒に対し、長い spec（1,000〜2,000字）を TUI へ流し込む描画が間に合っていないこと。**まず `--timeout-ms 180000` を試す。** これで直れば以下の回復手順は全部不要になる。

## 起動

### 自動承認フラグを付ける

付けないと worker が権限確認プロンプトで停止し、コーディネーターが完了を待ち続けるデッドロックになる。**opencode に `--yolo` は無い。正しくは `--auto`。**

`worker-start` は agent へカスタム引数を渡せない（`--model` / `--effort` のみ、しかも **opencode は `--model` 非対応**で `Agent opencode does not support launch-time model selection.` になる）。自動承認が要るなら低レベル経路を使う:

```bash
orca terminal create --worktree active --title "<task-name>" --command "opencode --auto" --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration worker-start --task <task_id> --terminal <handle> --json
```

最後を `dispatch --inject` にすると supervised な worker_dispatches 行が作られず、`worker-release` によるターミナル自動クローズが効かなくなる。**supervision が要るなら `worker-start --terminal <handle>`** を使う。

### spec に必ず入れる項目

worker は spec しか見ない。以下が抜けると事故る。

- Issue の URL と、**「issue本文よりこの spec を優先せよ」の一文**（本文が信用できないリポジトリがある。このリポジトリの実例は [AGENTS.md](../../../AGENTS.md) 参照）
- 依存タスクの Task ID
- 受け入れ基準（実行すべきコマンドを具体的に）
- 参照すべき ADR
- **コミットは誰がするか**（worker がするのか、コーディネーターがするのか）
- **同一ファイルを触る並行タスクの名前**（あれば）

## 失敗したときの判別

`worker-start` が非ゼロで返っても、**即リトライしてはいけない。**

```bash
orca terminal read --terminal <handle> --json
```

- **spec が届いて作業を始めている** → リトライしない。そのまま作業させ、下の「完了検知」へ進む
- **本当に何も届いていない** → `--retry-of <dispatch_id>` でリトライする

盲目的にリトライすると**同一worktreeに二重の worker が走る**。2026-08-29 のセッションでは実際にこれが起き、片方を `terminal send` で停止させて収拾した。停止指示は「編集を中断し、未保存の作業内容を報告せよ。破棄はしない」と伝えると素直に止まる。

## 完了検知

**`terminal wait --for tui-idle` を信用しない。** opencode は思考中でも `satisfied: true` を即返す。2026-08-29 のセッションでは10往復以上これで空振りした。

capability が revoke されていても、**拒否されたメールには本文と payload が完全に残る**。これが実質の完了検知チャネルになる:

```bash
orca orchestration check --run <run_id> --peek --all --json \
  | jq '.result.messages[] | select(.type=="worker_done")'
```

Monitor で20秒間隔にポーリングし、`payload | fromjson | .taskId` で自分の待っているタスクだけ拾うのが確実だった。`--peek` は mail を消費しないので、`check --wait` と併用できる。

`heartbeat` の `phase` も観測できる（`implementing` → `reviewing` と進むので完了が近いか分かる）。

## 手動での完了処理

`worker_done` が拒否された場合、コーディネーターが肩代わりする。

1. **内容を自分で独立検証する。** worker の自己申告を信じない。受け入れ基準のコマンド（`bun run test` 等）を自分で回す
2. **コミットする**（spec でコミット責任者をコーディネーターと決めた場合）。issue単位で分ける
3. **Run をバインドし直す。** `task-update` が `run_required: No Run is bound` で落ちるのが頻発する:
   ```bash
   orca orchestration run-use --id <run_id> --json
   ```
4. **手動で完了させる。** `--result` に worker の payload を転記し、`note` に経緯を必ず残す:
   ```bash
   orca orchestration task-update --id <task_id> --status completed \
     --result '{"outcome":"succeeded","filesModified":[...],"commit":"<sha>",
                "summary":"...",
                "note":"dispatch <id> の worker_done は capability revoked のため自動拒否されたが実処理は完了。コーディネーターが検証・コミットし手動で完了扱いにした。"}' \
     --json
   ```

`note` を省くと、後から見たときに「なぜ worker_done 無しで completed になっているのか」が追えなくなる。

## 後始末

完了したタスクの worker は**その場で**閉じる。後回しにしない。

```bash
orca orchestration worker-release --dispatch <dispatch_id> --json
```

`state: "released" / processAction: "closed_agent_terminal"` なら成功。ただし **`state: "retained" / reason: "user_takeover"` を返して閉じられないことがある**（2026-08-29 は 9 件中 4 件がこれ。条件は未特定）。

その場合は `terminal close` で代替しない。**閉じられなかった旨とタブ名をユーザーに伝えて手動クローズを依頼する。**

## 同一worktreeで並列させるとき

**DAGの依存関係はファイル競合を防がない。** 論理的に独立でも、同じファイルを触る2タスクを並列させると壊れる。

2026-08-29 の実例: #28（compaction登録）と #31（失敗通知）が同時に `src/slack/bot.ts` を編集し、#31 から「#28 の未完成コードで typecheck が壊れて進めない」というエスカレーションが上がった。最終的に両者の変更が**1コミットに混ざり**、issue単位のtraceabilityが失われた。

対策はどちらか:

- **並列タスクを別worktreeに分ける**（`--worktree new-child` / `new-top-level`）
- **同じファイルを触るタスクは論理依存がなくても直列化する**（DAGに人工的な依存を足す）

同一worktreeを選ぶなら、spec に「このタスクは <他タスク> と同じ `<path>` を触る。こまめにコミットし、共有前に `git status` / `git diff` で他workerの変更を確認して rebase せよ」と明記する。それでも上記の事故は起きうる。

## 監視中に流れるメッセージの扱い

- 拒否された `heartbeat` / `escalation` / `worker_done` は**全て `check` に流れてくる**。処理したら `--ack <delivery_id>` する。ack しないと同じ Delivery が再生され続ける
- 同じ内容の `worker_done` が**複数回届く**ことがある（worker がリトライするため）。taskId で冪等に処理する
- worker が「re-dispatch して worker_done を受理させてほしい」とエスカレーションしてくることがあるが、**re-dispatch しても capability は戻らない**。手動完了処理で対応する
