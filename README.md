# Model Agent MCP PoC

Cursor Local Agent と Cursor Cloud Agent が同じ Remote Streamable HTTP MCP (`/mcp`) に接続し、CLIProxyAPI 経由で Claude または Codex/GPT モデルへ実装相談する PoC です。Synapse と Claude Code CLI/TUI は使いません。

```text
Cursor Local Agent ─┐
                    ├── HTTPS → Model Agent MCP → CLIProxyAPI → Claude/Codex OAuth
Cursor Cloud Agent ─┘
```

MCP はリポジトリを開かず、編集・shell・test・git も実行しません。Cursor が必要なコードと制約を `context` に渡し、提案や diff を検証して適用します。モデルはツール引数またはセッションごとに選びます。

## 必要なもの

- Node.js 20 以上、npm。コンテナで動かす場合は Docker Compose。
- CLIProxyAPI のインスタンスと、その `api-keys` に設定したキー。
- Claude を使う場合は CLIProxyAPI に Claude OAuth、Codex/GPT を使う場合は Codex OAuth を設定する。実際に使えるモデル ID は `/v1/models` で確認してください。

CLIProxyAPI は OpenAI/Claude 互換 API と Claude Code / Codex OAuth ログインを提供します。この MCP は両系統を統一するため、OpenAI 互換の `GET /v1/models` と `POST /v1/chat/completions` を使います。CLIProxyAPI の OAuth は MCP の Bearer 認証とは別です。ChatGPT 契約を OpenAI Platform API クレジットに変換するものでもありません。

## 起動: Node.js

```bash
cp .env.example .env
# .env の MCP_BEARER_TOKEN, CLIPROXY_BASE_URL, CLIPROXY_API_KEY,
# DEFAULT_MODEL を実際の値に変更する
npm ci
npm run build
npm start
```

`CLIPROXY_BASE_URL` は `/v1` を付けない origin (`http://127.0.0.1:8317`) です。長くランダムな `MCP_BEARER_TOKEN` を使い、CLIProxyAPI のキーとは別にしてください。`DEFAULT_MODEL` はタスクでモデルを省略した場合に使います。`MODEL_MAX_TOKENS` と `CLIPROXY_TIMEOUT_MS` も設定できます。

## 起動: Docker Compose

```bash
cp .env.example .env
cp cliproxy.config.example.yaml cliproxy.config.yaml
mkdir -p cliproxy-auth
# .env に MCP_BEARER_TOKEN、CLIPROXY_API_KEY、DEFAULT_MODEL を設定する
# cliproxy.config.yaml の api-keys に、同じ CLIPROXY_API_KEY 値を設定する
docker compose up -d --build
```

Compose は MCP と CLIProxyAPI を別サービスにし、`CLIPROXY_BASE_URL=http://cli-proxy-api:8317` で接続します。CLIProxyAPI の YAML `api-keys` は `.env` を自動展開しないため、両方に同じキーを手動設定してください。OAuth 認証情報は `cliproxy-auth/` に保持され、Git には含まれません。`CLIPROXY_IMAGE` を指定して運用時の CLIProxyAPI イメージを固定できます。

CLIProxyAPI への OAuth ログイン例:

```bash
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser --claude-login
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser --codex-login
```

ログインは必要な方だけ実行します。Compose は Claude の callback `54545` と Codex の `1455` を localhost に公開します。リモートホストで OAuth する場合は公式 CLIProxyAPI ドキュメントの SSH port forwarding または管理 UI 手順に従ってください。OAuth の可用性と利用条件はアカウントと CLIProxyAPI の現行仕様を確認してください。

Compose の MCP ポートは localhost のみで、リモート接続には **HTTPS リバースプロキシ**で `https://mcp.example.com/mcp` を公開します。CLIProxyAPI の `8317` や OAuth callback ポートをインターネットへ公開しないでください。MCP はリバースプロキシ側で TLS を終端します。

## Cursor の接続設定

Local Agent: [`.cursor/mcp.json`](.cursor/mcp.json) を接続先リポジトリへコピーするか、個人用の `~/.cursor/mcp.json` に置きます。URL と Bearer token を実際の値に置き換え、Cursor を再起動します。共有リポジトリへ実トークンをコミットしないでください。

Cloud Agent: Cursor の `cursor.com/agents` の MCP 設定で、同じ名前・HTTPS URL・`Authorization: Bearer <token>` ヘッダーを登録します。チーム利用時は Dashboard → Plugins & MCPs の共有設定も使えます。Cloud Agent は HTTP MCP の設定と資格情報をバックエンド経由で扱います。Cloud 用設定がローカル `.cursor/mcp.json` だけで自動的に有効になるとは想定しないでください。

Cursor に渡す実装ルールの例は [`examples/AGENTS.md`](examples/AGENTS.md) です。接続先リポジトリの `AGENTS.md` または Cursor Rules にコピーして調整してください。

## MCP ツール

| ツール | 入力 | 結果 |
| --- | --- | --- |
| `agent_list_models` | なし | CLIProxyAPI が公開するモデル ID と既定モデル |
| `agent_start_task` | `task`, `context?`, `model?` | `session_id`, model, status, 初回応答 |
| `agent_continue_task` | `session_id`, `message` | 履歴を使った応答 |
| `agent_set_session_model` | `session_id`, `model` | 次のターンから使うモデルを変更 |
| `agent_get_session` | `session_id` | 状態、モデル、日時、履歴の短いプレビュー |
| `agent_cancel_task` | `session_id` | 実行中の呼び出しを中断し、セッションを終了 |

モデル ID は `agent_list_models` で探せますが、リスト掲載だけでは認証・クォータ・そのモデルの chat endpoint 対応は保証されません。モデルを切り替えると会話テキストは維持されます。モデル固有の内部状態やツール利用結果は引き継ぎません。

## 疎通確認

```bash
set -a; . ./.env; set +a
curl -i http://127.0.0.1:8765/healthz
curl -i http://127.0.0.1:8765/mcp # 401 が正常
curl -sS http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer $CLIPROXY_API_KEY"
```

MCP の初期化とモデル一覧は、Bearer token を渡して確認します:

```bash
curl -sS http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'

curl -sS http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_list_models","arguments":{}}}'
```

`agent_start_task` は CLIProxyAPI の実モデルへ課金や契約枠を使う呼び出しです。まず `agent_list_models` と CLIProxyAPI 側の `/v1/models` を確認してください。

## 検証と PoC の制約

```bash
npm run lint
npm run typecheck
npm test
npm run build
docker compose config
```

セッションはメモリに保存し、プロセス再起動で失われます。`SessionStore` インターフェースを Redis 等に差し替えられますが、分散実行時には同一セッションの排他制御とキャンセル通知も共有化が必要です。現実装は単一インスタンス向けです。単一 Bearer token を共有するクライアントは、セッション ID を知ればそのセッションを操作できます。複数利用者を分離する場合はトークンごとの所有権検証を追加してください。初回 `agent_start_task` は応答完了後に `session_id` を返すため、その初回処理中は別リクエストからキャンセルできません。

## 参照資料

- [CLIProxyAPI README](https://github.com/router-for-me/CLIProxyAPI)
- [CLIProxyAPI 基本設定](https://help.router-for.me/configuration/basic)
- [CLIProxyAPI Claude OAuth](https://help.router-for.me/configuration/provider/claude-code)
- [CLIProxyAPI Codex OAuth](https://help.router-for.me/configuration/provider/codex)
- [CLIProxyAPI Docker Compose](https://help.router-for.me/docker/docker-compose)
- [Cursor MCP 設定](https://prod.cursor.com/help/customization/mcp)
- [Cursor Cloud Agent MCP](https://cursor.com/docs/cloud-agent/capabilities)

## 近い既存リポジトリ

- [claude-team-mcp](https://github.com/7836246/claude-team-mcp): Cursor 対応の複数モデル MCP。README の設定例はローカル `npx`/stdio で、プロジェクトファイル読取ツールも含みます。
- [btcjon/cliproxyapi](https://github.com/btcjon/cliproxyapi): CLIProxyAPI の運用例。`cursor-agent-mcp-server.js` は Claude 側から Cursor Agent CLI を起動する逆向きの橋です。
- [claudex-cli-proxy-guide](https://github.com/elephantjohn/claudex-cli-proxy-guide): CLIProxyAPI の Codex OAuth とモデル疎通確認の例。Remote MCP ではありません。
