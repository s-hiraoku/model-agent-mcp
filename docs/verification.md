# 検証状況と PoC の制約

「コードに存在する」「ローカルで動いた」「実サービスへ到達した」を分けて記録します。最終更新日は 2026-09-26 です。

| 対象 | 確認済みの根拠 | まだ言えないこと |
| --- | --- | --- |
| MCP transport と Bearer 認証 | SDK v2 の Streamable HTTP を[HTTP テスト](../test/http.test.ts)で接続・ツール呼び出し、認証なし 401 を確認。Node 起動時に `/healthz` 200 と `/mcp` 401 を確認 | 公開 HTTPS と Cursor からの接続 |
| モデル API クライアント | [クライアントテスト](../test/proxy-client.test.ts)の fetch で `/v1/models`、`/v1/chat/completions`、Bearer ヘッダー、エラー処理を確認 | 実 CLIProxyAPI の OAuth と各モデルへの成功 |
| 会話セッション | [セッションテスト](../test/session-service.test.ts)で履歴継続、モデル切替、キャンセル、失敗後の再試行を確認 | 再起動後の保持、複数インスタンス間の整合性 |
| 既定モデルの変更 | セッションテストで新規依頼への適用、既存セッションと明示指定の維持を確認。HTTP テストで MCP ツール経由の設定と読み戻しを確認 | 実サービスでの複数クライアント同時利用と再起動後の確認 |
| ビルドと設定 | Node.js 26.10.0 で `npm ci`、Biome lint、typecheck、TypeScript build を実行。`docker compose config --quiet` を確認。`node:26.10.0-alpine` の公開 manifest を確認 | Docker イメージの実ビルドとコンテナ起動。検証環境の Docker デーモンへ接続できなかった |
| Cursor Local / Cloud | 公式 MCP 設定仕様を確認し、設定例を記載 | 実際の Cursor UI での tool discovery・呼び出し、両者が同じ URL を使った動作 |

## 実サービスで必要な確認順

1. CLIProxyAPI で必要な OAuth ログインを完了し、`GET /v1/models` に目的のモデルが現れることを確認する。
2. モデルごとに `POST /v1/chat/completions` の小さな非ストリーミング応答を確認する。モデル一覧だけでは推論成功を証明しない。
3. MCP の `/healthz`、無認証 401、認証済み初期化、`agent_list_models`、`agent_start_task`、`agent_continue_task` を確認する。
4. 公開 HTTPS URL と Bearer ヘッダーで同じ呼び出しを確認する。
5. Cursor Local Agent と Cursor Cloud Agent に同じ URL を登録し、それぞれからツールを呼ぶ。Cloud 側では認証失敗や接続エラーを確認する。
6. モデルが返したパッチ案を Cursor 側でレビュー・適用し、実 repo の diff とテストを確認する。

この順番で得られるのは段階ごとの証拠です。たとえば Compose の構文チェックはコンテナ稼働の証明にはならず、MCP の単体テストは OAuth 付き推論の証明にはなりません。

## 現行 PoC の制約

- メモリ上のセッションはプロセス再起動で失われます。単一インスタンスを前提にしています。
- 稼働中に変更した既定モデルも再起動で `DEFAULT_MODEL` に戻ります。全クライアントで一つの既定値を共有します。
- 全クライアントが一つの MCP Bearer token を共有する構成です。利用者ごとのセッション所有権、レート制限、監査ログはありません。
- 初回 `agent_start_task` は応答後に `session_id` が分かるため、初回実行中の外部キャンセルはできません。
- `agent_get_session` は履歴の先頭 200 文字ずつしか返しません。応答全文の再取得や検索はできません。
- モデル呼び出しはテキストのみ・非ストリーミングです。モデルにファイル編集や shell のツールを渡しません。
- 入力と履歴は呼び出し元から CLIProxyAPI と選択モデルへ送られます。秘密情報を `context` に含めない運用が必要です。
- `agent_list_models` の結果は chat endpoint の対応表ではありません。モデル切替の時点でも ID を検証せず、次の推論で CLIProxyAPI の成否が分かります。
- CLIProxyAPI イメージは Compose の初期値が `latest` です。再現性が必要な配備では `CLIPROXY_IMAGE` を固定します。

永続化や複数利用者への公開を進める場合、`SessionStore` の交換だけでは足りません。所有権チェック、共有排他、キャンセル伝達、保持期限とデータ削除をまとめて設計する必要があります。
