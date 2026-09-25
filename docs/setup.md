# セットアップ

最初は CLIProxyAPI と MCP を同じホストで動かし、localhost で疎通確認します。その後、MCP の `/mcp` だけを HTTPS で公開し、Cursor Local / Cloud に同じ URL を登録します。CLIProxyAPI の認証とモデルが未設定なら、MCP 自体が起動してもモデル呼び出しは成功しません。

## 1. CLIProxyAPI と OAuth を準備

CLIProxyAPI には MCP から送る API key を `api-keys` に設定します。Claude を使うなら [Claude OAuth](https://help.router-for.me/configuration/provider/claude-code)、Codex/GPT を使うなら [Codex OAuth](https://help.router-for.me/configuration/provider/codex) を設定してください。認証情報は CLIProxyAPI の `auth-dir` に保存されます。契約種別と利用条件、モデルの可用性はアカウント側で確認してください。

モデル ID は CLIProxyAPI から取得します。

```bash
curl -fsS http://127.0.0.1:8317/v1/models \
  -H "Authorization: Bearer $CLIPROXY_API_KEY"
```

リストに載っただけでは chat endpoint による推論成功を証明しません。OAuth、クォータ、モデルのルートが動くことは、後述の `agent_start_task` まで確認します。

## 2A. Node.js で MCP を起動

Node.js 26.10.0 を使います。`.nvmrc` と Dockerfile もこのバージョンに合わせています。依存ライブラリの固定バージョンは [依存関係](dependencies.md) を参照してください。

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

`.env` に実値を設定してください。ローカルで別プロセスの CLIProxyAPI に接続する場合、サンプルの Docker サービス名を **`CLIPROXY_BASE_URL=http://127.0.0.1:8317`** に変えます。URL は `/v1` を含まない origin です。Node.js でローカル疎通だけを行う間は `HOST=127.0.0.1` にできます。Compose 内ではコンテナ外から転送されたリクエストを受けるため、サンプルの `HOST=0.0.0.0` を使います。

| 環境変数 | 意味 |
| --- | --- |
| `MCP_BEARER_TOKEN` | MCP クライアントからのアクセスに使う長いランダムな token |
| `CLIPROXY_BASE_URL` | CLIProxyAPI の HTTP origin |
| `CLIPROXY_API_KEY` | CLIProxyAPI の `api-keys` と一致する key |
| `DEFAULT_MODEL` | `agent_start_task` で model を省略したときの ID |
| `MODEL_MAX_TOKENS` | 1 回のモデル応答の上限。サンプルは 4096 |
| `CLIPROXY_TIMEOUT_MS` | 上流呼び出しのタイムアウト。サンプルは 120000 |
| `HOST` / `PORT` | MCP の bind 先。サンプルは `0.0.0.0:8765` |

`MCP_BEARER_TOKEN` と `CLIPROXY_API_KEY` は別の値にしてください。`.env` と OAuth credential は Git に含めません。

## 2B. Docker Compose で二つのサービスを起動

```bash
cp .env.example .env
cp cliproxy.config.example.yaml cliproxy.config.yaml
mkdir -p cliproxy-auth
# .env の token、proxy key、モデルを変更する
# cliproxy.config.yaml の api-keys に同じ CLIPROXY_API_KEY を書く
docker compose up -d --build
```

`model-agent-mcp` は `http://cli-proxy-api:8317` へ接続します。CLIProxyAPI の設定ファイルは `.env` の変数を自動展開しないので、サンプル YAML の `api-keys` は手動で書き換えます。OAuth 情報は `cliproxy-auth/` に保持します。イメージを固定する場合は `CLIPROXY_IMAGE` を指定してください。[CLIProxyAPI Docker Compose 手順](https://help.router-for.me/docker/docker-compose)。

必要な OAuth だけログインします。

```bash
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser --claude-login
docker compose exec cli-proxy-api /CLIProxyAPI/CLIProxyAPI -no-browser --codex-login
```

Compose は Claude callback の `54545` と Codex callback の `1455` を localhost に bind します。リモートホストでログインする場合は、CLIProxyAPI 公式手順に従って callback へのポート転送や管理 UI を使ってください。CLIProxyAPI の API ポート `8317` と callback ポートを一般公開しない構成です。

## 3. HTTPS で MCP のみ公開

Compose の MCP ポートは `127.0.0.1:8765` です。リバースプロキシまたはトンネルで、公開 `https://mcp.example.com/mcp` をこの `/mcp` に転送します。TLS 終端と公開ドメインの設定は配備先に合わせて行います。この repo に Cloudflare Tunnel の構成や公開デプロイは含まれていません。

MCP を動かすホストから CLIProxyAPI に到達できれば、MCP と CLIProxyAPI は Docker ネットワーク上でも別ホストでもかまいません。`CLIPROXY_BASE_URL` はそのホストから到達できる内部 URL にします。Local と Cloud の MCP クライアントには **同じ公開 HTTPS URL** を登録するのが採用した構成です。

## 4. MCP クライアントを接続

### Cursor Local Agent

サンプルの [`.cursor/mcp.json`](../.cursor/mcp.json) を利用先の repo または個人用 `~/.cursor/mcp.json` に置き、URL と Bearer token を置き換えます。共有 repo へ実トークンを書いた設定をコミットしないでください。[Cursor MCP 設定](https://prod.cursor.com/help/customization/mcp)。

### Cursor Cloud Agent

`cursor.com/agents` の MCP 設定からカスタム HTTP サーバーを登録し、同じ HTTPS URL と `Authorization: Bearer <MCP_BEARER_TOKEN>` を設定します。チームでは Dashboard → Plugins & MCPs の共有設定も利用できます。Cloud Agent がローカル `.cursor/mcp.json` をそのまま読み取って同じ資格情報を使う前提にはしません。[Cursor Cloud Agent MCP](https://cursor.com/docs/cloud-agent/capabilities)。

### そのほかの MCP クライアント

Streamable HTTP とカスタム Authorization ヘッダーに対応するクライアントで `/mcp` に接続します。アプリケーションセッション ID はツール結果で受け取り、後続ツールに渡します。クライアント固有の資格情報保存方法と HTTP transport 対応状況を確認してください。MCP サーバー側のツールとモデル呼び出しは Cursor 固有の API に依存しません。

## 疎通確認

```bash
set -a; . ./.env; set +a
curl -i http://127.0.0.1:8765/healthz
curl -i http://127.0.0.1:8765/mcp # token なしなら 401
```

MCP 初期化の例:

```bash
curl -sS http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
```

モデル一覧ツールの例:

```bash
curl -sS http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agent_list_models","arguments":{}}}'
```

実モデルへの最小呼び出しは次のとおりです。`DEFAULT_MODEL` に有効なモデルを設定し、OAuth とクォータを確認してから実行してください。これはモデル利用枠を消費します。

```bash
curl -sS http://127.0.0.1:8765/mcp \
  -H "Authorization: Bearer $MCP_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"agent_start_task","arguments":{"task":"Reply with OK only"}}}'
```

Compose の `.env` をローカルで読み込んだ場合、`CLIPROXY_BASE_URL` の Docker サービス名はホストの shell から解決できません。ただし上の curl は localhost に公開されたポートへ送ります。公開後は MCP URL を HTTPS の URL に変え、Local と Cloud の両方から確認します。
