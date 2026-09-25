# 近い既存リポジトリ

2026-09-25 に確認した公開リポジトリです。設計の参考になりますが、いずれもこの PoC の直接の依存ではありません。プロジェクトは変化するため、採用時にはリンク先の現行コードを再確認してください。

| リポジトリ | 共通点 | この PoC との違い |
| --- | --- | --- |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) | Claude / Codex OAuth と互換 API を提供 | この PoC の上流サービス。MCP、クライアントとの会話セッション、repo 境界はこの repo 側が持つ |
| [7836246/claude-team-mcp](https://github.com/7836246/claude-team-mcp) | Cursor から複数モデルを使う MCP | README の接続例はローカル `npx`/stdio。複数 expert のオーケストレーションやファイル読取も扱う |
| [btcjon/cliproxyapi](https://github.com/btcjon/cliproxyapi/blob/main/scripts/cursor-agent-mcp-server.js) | CLIProxyAPI と Cursor Agent の連携例を含む | 該当スクリプトは Claude 側から Cursor Agent CLI を起動する逆向きの橋で、Remote HTTP MCP ではない |
| [elephantjohn/claudex-cli-proxy-guide](https://github.com/elephantjohn/claudex-cli-proxy-guide) | CLIProxyAPI の Codex OAuth とモデル疎通を説明 | Claude Code から Codex モデルを使うガイド。Remote MCP 実装ではない |

この PoC は、**複数の MCP クライアントから同じ Remote HTTP サービスに接続し、CLIProxyAPI のモデルを選んで、repo 操作は呼び出し元に残す**という境界に絞っています。既存リポジトリと比較して新規に作る理由は、この境界と最小限のセッション API を実装したかったためです。
