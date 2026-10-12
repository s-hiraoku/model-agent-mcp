# Model Agent MCP

モデルに実装相談を送り、会話を続ける Remote Streamable HTTP MCP の PoC です。CLIProxyAPI を通じて Claude と Codex/GPT 系モデルを選べます。最初の利用例は Cursor Local Agent / Cursor Cloud Agent ですが、Streamable HTTP と Bearer ヘッダーに対応する MCP クライアントからも利用できます。

```text
Cursor Local Agent ─┐
Cursor Cloud Agent ─┼─ HTTPS → Model Agent MCP → CLIProxyAPI → Claude / Codex OAuth
その他のMCPクライアント ┘
```

MCP は repo を読み書きしません。呼び出し元が関連コードを `context` に渡し、返ってきた方針やパッチ案を確認・適用・テストします。MCP のモデルは Cursor Agent のメインモデルを置き換えず、Claude Code CLI/TUI も起動しません。

## まず読む

- [ドキュメント目次](docs/README.md)
- [壁打ちの結論と変更した判断](docs/design-decisions.md)
- [アーキテクチャと責務](docs/architecture.md)
- [セットアップと Local / Cloud 接続](docs/setup.md)
- [ツールと実装ワークフロー](docs/tool-workflow.md)
- [検証状況と制約](docs/verification.md)

## 認証の移行と最小セットアップ

このbranchは専用Auth0 audienceとissuer/client/subject/scope検証へ移行します。共有Bearerの互換fallbackはありません。未設定はdeny-allです。[移行手順・制限・未確認項目](docs/auth0-migration.md)を先に確認してください。既存Docker/Funnel構成やAuth0設定はこの変更で更新しません。古いセットアップ例はそのまま本番に適用できず、私有設定とaudit volumeの配置を別途レビューする必要があります。

Node.js 26.10.0 と、認証済みの CLIProxyAPI が必要です。採用したバージョンと更新方針は [依存関係](docs/dependencies.md) に記録しています。

```bash
cp .env.example .env
# 承認済みAuth0私有設定パス、既存proxy key、DEFAULT_MODELを設定する
# ローカルの CLIProxyAPI を使う場合は CLIPROXY_BASE_URL=http://127.0.0.1:8317
npm ci
npm run build
npm start
```

Docker Compose では MCP と CLIProxyAPI を別サービスとして起動します。OAuth の準備、`cliproxy.config.yaml` の設定、HTTPS 公開と Cursor への登録は [セットアップ](docs/setup.md) を参照してください。実トークンや OAuth credential を Git にコミットしないでください。

## 公開ツール

| ツール | 用途 |
| --- | --- |
| `agent_list_models` | CLIProxyAPI のモデル ID を一覧表示 |
| `agent_set_default_model` | 新規相談で使う既定モデルを変更 |
| `agent_start_task` | モデルと context を指定して相談を開始 |
| `agent_continue_task` | 同じ会話を続行 |
| `agent_set_session_model` | 次の応答からモデルを変更 |
| `agent_get_session` | 状態と履歴の短いプレビューを確認 |
| `agent_cancel_task` | 実行中の処理を中断し、セッションを終了 |

セッションは現在メモリ保存で、再起動すると消えます。既定モデルは `.env` の `DEFAULT_MODEL` で起動時に設定し、`agent_set_default_model` で稼働中に変更できます。稼働中の変更は全クライアントに共通で、再起動すると `.env` の値に戻ります。モデルに渡すのは呼び出し元が提供した文脈と会話履歴です。詳しい入出力は [ツールと実装ワークフロー](docs/tool-workflow.md) にあります。

本番の自動model fallbackは無効です。グローバル既定モデルの変更には明示的な`model:admin` scopeが必要で、sessionはissuer・subject・clientの組で隔離されます。利用エージェントには、最初のモデル呼び出し前に **「Model Agent MCPをmodel ○○で使います。」** と表示するよう MCP の instructions と [Cursor 用ルール例](examples/AGENTS.md) で指示しています。

## 開発時の確認

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

実 CLIProxyAPI の OAuth 推論と Cursor Local / Cloud からの公開 URL 経由の呼び出しは、まだこの repo のローカルテストで証明されていません。[検証状況と制約](docs/verification.md) に、確認済みの範囲と実サービスでの確認順を記録しています。

## 参照

- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
- [Cursor の MCP 設定](https://prod.cursor.com/help/customization/mcp)
- [Cursor Cloud Agent の MCP](https://cursor.com/docs/cloud-agent/capabilities)
