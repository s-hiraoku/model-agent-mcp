# 依存関係と更新方針

2026-09-25 に Node.js の公式リリース情報と npm registry の `latest` を確認し、直接依存を exact version で固定しました。再現可能なインストールには `npm ci` と `package-lock.json` を使います。「最新」はこの確認日の状態であり、将来の自動更新を意味しません。

| 対象 | 固定バージョン | 用途 |
| --- | --- | --- |
| Node.js | 26.10.0 Current | `.nvmrc`、`package.json` の engines、Dockerfile |
| `@modelcontextprotocol/server` / `@modelcontextprotocol/node` | 2.1.0 | Streamable HTTP MCP サーバーと Node HTTP adapter |
| `@modelcontextprotocol/client` | 2.1.0 | HTTP 統合テスト専用 |
| Express | 5.2.1 | `/mcp` と `/healthz` の HTTP ルーティング |
| Zod | 4.6.5 | MCP ツールの入力スキーマ |
| TypeScript | 7.0.2 | 型チェックとビルド |
| Biome | 2.5.14 | lint |
| `@types/node` / `@types/express` | 26.6.2 / 5.0.6 | 開発時の型定義 |
| tsx | 4.23.15 | 開発起動とテスト |

MCP SDK は v1 の単一 `@modelcontextprotocol/sdk` から v2 の分割パッケージへ移しました。v2 の `createMcpHandler` はリクエストごとにサーバーを生成し、既存のアプリケーション会話セッションは `SessionStore` に残します。TypeScript 7.0 と現行 `typescript-eslint` の組み合わせでは lint が起動できなかったため、lint は現行 Biome へ移しました。

確認した一次資料: [Node.js 26.10.0](https://nodejs.org/en/blog/release/v26.10.0)、[MCP TypeScript SDK v2 の案内](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/README.md)、[SDK v2 の HTTP 提供方法](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)。実際の固定バージョンの正本は [`package.json`](../package.json) と [`package-lock.json`](../package-lock.json) です。
