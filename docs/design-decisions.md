# 設計相談の記録

2026 年 9 月の「CursorとClaude Code連携」の壁打ちと、その後のこのプロジェクトでの変更を、時系列ではなく判断ごとに整理しました。会話で出た案には後で撤回・変更されたものがあります。以下の「採用」が現在の基準です。

## 最初に解きたかったこと

Cursor Cloud Agent から、Claude Code の契約で認証した Claude モデルに実装相談を送り、Cursor の調査・編集・検証・PR 作成と組み合わせたい、という出発点でした。途中で **Cursor Local Agent からも同じ仕組みを使う**条件が加わりました。

その後、CLIProxyAPI の利用と、Synapse を構成に含めないことが明示されました。さらにこのプロジェクトの実装中に、Claude だけでなく CLIProxyAPI に登録された Codex/GPT 系モデルも MCP から選びたい、という要件が追加されました。

### 判断を確定・変更した発言

| 発言の要点 | 文書に残した結論 |
| --- | --- |
| 「両方とも考慮した設計にしたい」 | Local と Cloud の二つの Cursor Agent から使う |
| 「MCPサーバはremote でいいよね？」 | Remote HTTP MCP を一つ置く |
| 「これが一番シンプルじゃない？」 | Cursor → MCP → CLIProxyAPI の小さな構成に絞る |
| 「これで実装したい」 | 独立した PoC として実装する |
| 「MCPにモデル設定の機能も持たせたら」 | Claude に限定せずモデル一覧・指定・切替を追加する |
| 「このMCPってもっと汎用的に使えるよね？」 | Cursor を最初の利用例とし、サーバーの指示文とツール説明はクライアント非依存にする |
| 「デフォルトで使用するmodelを設定できるようにして」 | 起動時の `DEFAULT_MODEL` に加え、稼働中に共有の既定モデルを変更するツールを追加する |

この表は会話の設計上の転機を短く記したもので、全文転記ではありません。以前の回答に含まれた案のうち、後のユーザー判断と食い違うものは下の「採用しなかった案」に分けています。

## 採用した構成

```text
Cursor Local Agent ─┐
                    ├─ HTTPS → Remote Streamable HTTP MCP → CLIProxyAPI → モデル
Cursor Cloud Agent ─┘
```

本番相当の接続では、Local と Cloud の双方が同じ公開 HTTPS URL を使います。MCP は一つのサービスです。CLIProxyAPI は MCP の背後に置き、Cursor には直接公開しません。Claude Code CLI/TUI を起動したり操作したりする構成にはしません。

これは **Cursor での利用を前提に考えた構成**であり、MCP サーバーのクライアントを Cursor に限定する判断ではありません。Streamable HTTP と Bearer ヘッダーに対応するほかの MCP クライアントも接続できます。repo 操作を呼び出し元に残す境界は共通です。Cursor 固有の設定とルールは利用例として提供します。

### なぜ Remote HTTP MCP か

Local と Cloud でツール名・会話状態・認証境界を揃えられます。Cursor Cloud Agent はカスタム HTTP MCP をサポートし、HTTP 用の認証ヘッダーを Cloud Agent の VM ではなく Cursor のバックエンドで扱います。[Cursor Cloud Agent の MCP 仕様](https://cursor.com/docs/cloud-agent/capabilities)。

壁打ちの途中では「Local は localhost、Cloud はトンネル」という接続経路も検討しました。最後にユーザーが **Local も最初から同じ Remote MCP URL を使う**方針を選びました。localhost は開発時の疎通確認に使えますが、採用した共有設定の中心ではありません。

### なぜ CLIProxyAPI か

CLIProxyAPI が OAuth 認証と互換 API を扱い、MCP は通常の HTTP クライアントとセッション管理に集中できます。[CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI)。モデル追加後の実装では、Claude と Codex/GPT の両方を呼べる OpenAI 互換の `GET /v1/models` と `POST /v1/chat/completions` を採用しました。

この方式で得るのは **モデルへの API 呼び出し**です。Claude Code アプリケーションの agent loop、内蔵ツール、`CLAUDE.md` の自動読込、Skills、Plan mode、TUI セッションを MCP に移す設計ではありません。また MCP のモデルは Cursor Agent のメインモデルを置き換えません。Cursor が MCP ツールを呼び、その結果を受け取ります。

### なぜ repo は Cursor が持つか

Cloud Agent のチェックアウトと Remote MCP が動くホストのファイルは同一ではありません。MCP 側で直接ファイル編集をすると、どのコピーを変更するか、どう同期するかが問題になります。そのため **呼び出し元が repo の調査、ファイル編集、shell、test、diff 確認、git/PR を担当**し、MCP は実装方針・コード・パッチ案を返します。Cursor 利用時は Cursor が結果を検証してから自分の環境へ適用します。

壁打ちでは「Claude が独立した coding agent として repo を編集する」案も出ましたが、共有 Remote MCP の最小 PoC では採用していません。現在の MCP は repo を読みません。Cursor が関連ファイルと制約を `context` に渡す必要があります。

### なぜ会話セッションを持つか

単発の `ask_model(prompt)` だけでは、確認・修正・再提案のやり取りが続きません。MCP が `session_id` とメッセージ履歴を持ち、`agent_start_task` と `agent_continue_task` で同じ相談を続けます。現在の保存先はメモリです。MCP transport 自体はステートレス HTTP で、アプリケーションの会話セッションとは別の概念です。

## 途中で検討し、現行 PoC に採用しなかった案

| 案 | 壁打ちで得たこと | 現在の扱い |
| --- | --- | --- |
| `claude -p` や tmux で Claude Code CLI/TUI を操作 | Claude Code 本体のツールや作業環境を使えるが、プロセス・TTY・認証・権限確認の管理が必要 | CLI/TUI を直接操作しないという最終要件により不採用 |
| Cursor Cloud VM 内の stdio MCP | VM で起動できるが、Local と同じ Remote URL にはならず、CLIProxyAPI への到達性も別途必要 | 不採用 |
| Mac mini の localhost と Cloud 用トンネルを使い分ける | 同じ MCP 実体を使える | 最終判断では Local も公開 HTTPS URL に接続 |
| Cursor のメインモデルへ CLIProxyAPI を直接指定 | MCP を介さない構想 | Cloud Agent のメインモデル差し替え手段としては確認できず、PoC の設計外 |
| Remote MCP が Git checkout を持ち直接編集 | モデルを独立した実装 agent に近づけられる | repo 同期・権限・競合の設計が必要なため見送り |
| Synapse を挟む | 初期案ではオーケストレーター候補 | ユーザーの指示により構成から除外 |

## 実装時に変更した名前と機能

最初の会話では `claude-agent`、`claude_start_task` のような名前を例示しました。モデルを Claude に限定しない要件に変わったため、実装名は `model-agent` と `agent_*` ツールです。会話中の `get_result` / `get_status` は構想例で、現行実装では `agent_get_session` が状態と履歴の短いプレビューを返します。応答全文は `agent_start_task` / `agent_continue_task` の結果として受け取ります。

## 残る確認

この記録は設計判断を保存します。実際の Claude / Codex OAuth、CLIProxyAPI の当該モデルへのルーティング、Cursor Local / Cloud から同じ HTTPS URL に到達できることは、それぞれ別の疎通確認が必要です。確認項目は [検証状況と制約](verification.md) にまとめました。
