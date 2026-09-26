# ツールと実装ワークフロー

ツールは Cursor に限らず、MCP クライアントに同じ名前で公開されます。以下はツール引数の例であり、HTTP の JSON-RPC 本文ではありません。HTTP での確認方法は [セットアップ](setup.md#疎通確認) にあります。

## ツール一覧

| ツール | 入力 | 主な返却値 |
| --- | --- | --- |
| `agent_list_models` | なし | `default_model`, `models` |
| `agent_set_default_model` | `model` | `default_model` |
| `agent_start_task` | `task`, `context?`, `model?` | `session_id`, `model`, `status`, `response?`, `error?` |
| `agent_continue_task` | `session_id`, `message` | `session_id`, `model`, `status`, `response?`, `error?` |
| `agent_set_session_model` | `session_id`, `model` | `session_id`, `model` |
| `agent_get_session` | `session_id` | 状態、日時、ターン数、履歴の短いプレビュー |
| `agent_cancel_task` | `session_id` | `session_id`, `status: "cancelled"` |

`task`、`message`、`context` は空文字不可・最大 200,000 文字です。`model` は CLIProxyAPI が受け付けるモデル ID または alias を指定します。二つのモデル設定ツールは ID の存在を事前確認せず、実際の成否は次のモデル呼び出しで分かります。

`agent_set_default_model` は `agent_start_task` で `model` を省略した新規セッションだけに適用します。既存セッションや明示的にモデルを指定した依頼には影響しません。稼働中の全 MCP クライアントで共有され、再起動すると `.env` の `DEFAULT_MODEL` に戻ります。現在値は `agent_list_models` の `default_model` で確認できます。

## Cursor での基本的な使い方

1. Cursor が issue、対象ファイル、既存テスト、制約を調べます。
2. 必要なら `agent_list_models` で候補 ID と既定モデルを見ます。共有の既定値を変える場合は `agent_set_default_model` を呼びます。
3. 関連するコードと要件を `context` にまとめ、`agent_start_task` で実装案を求めます。
4. 返った提案・diff の適用先と前提を Cursor が確認し、自分のチェックアウトを編集します。
5. Cursor が diff、lint、テストを確認します。失敗内容や追加条件を `agent_continue_task` に送り、同じ会話を続けます。
6. 最終的な git / PR 操作は Cursor が行います。

接続先 repo に入れる Cursor 用ルール例は [`examples/AGENTS.md`](../examples/AGENTS.md) です。ほかのクライアントでは同じ考え方を、そのクライアントの repo 操作手順に置き換えられます。

### 最初の依頼

```json
{
  "task": "認証エラー時の再試行を実装するための変更案と unified diff を示して",
  "context": "対象は src/auth.ts と test/auth.test.ts。既存の retry は 429 のみ。現状の関数とテストの抜粋: ...",
  "model": "claude-sonnet-4-6"
}
```

返却値の例:

```json
{
  "session_id": "e9939664-d98b-4a02-b46e-cd8615d544d8",
  "model": "claude-sonnet-4-6",
  "status": "ready",
  "response": "提案と diff のテキスト ..."
}
```

この `response` はモデル出力であり、適用済みの変更ではありません。モデルは repo を読んでいません。ファイル名、API、型、既存のテストを Cursor 側で確認してください。

### 追加相談とモデル切替

```json
{ "session_id": "e9939664-d98b-4a02-b46e-cd8615d544d8", "message": "テストではタイムアウト時に二重送信されました。原因と最小修正を提案して" }
```

別モデルに同じ会話の続きから相談する場合は `agent_set_session_model` を呼び、続けて `agent_continue_task` を呼びます。変更前の会話テキストは維持されます。モデル別の隠れた状態やツールの実行結果は引き継がれません。独立した比較をしたいときは、新しい `agent_start_task` をそれぞれのモデルで始めてください。

## セッション状態とエラー

```text
start → running → ready → running → ready ...
                ↘ error ────→ 再試行可能
                ↘ cancelled → 終了
```

- 上流 API が失敗すると、開始・継続ツールは `status: "error"` と `error` を返します。失敗したユーザーメッセージは履歴に追加されず、同じセッションで再試行できます。
- 無効な `session_id`、処理中セッションへの重複送信、キャンセル済みセッションの継続は MCP ツールエラーになります。
- `agent_cancel_task` は処理中の HTTP 呼び出しを中断し、セッションを終了します。`agent_get_session` ではキャンセル後もメタデータを読めます。
- 初回 `agent_start_task` はモデル応答を待ってから `session_id` を返すため、その初回の処理中に別リクエストからキャンセルすることはできません。
- `agent_get_session` は各メッセージの先頭 200 文字までを返します。全文を後から取得するツールはありません。必要な応答は開始・継続ツールの結果で保存してください。

上流へのリクエストは非ストリーミングで、モデルにファイル・shell ツールを渡しません。長い実装案は 1 回の応答として返ります。入出力の上限やタイムアウトは `.env` の `MODEL_MAX_TOKENS` と `CLIPROXY_TIMEOUT_MS` で調整します。
