# logwatch

Mac のシステムログを集め、平常時のパターンから外れた動きを検知する仕組み。

```
agent (Swift) ──1分ごとの件数──▶ server (Next.js) ──▶ PostgreSQL
                                     │
                                     └─▶ 異常検知・ダッシュボード(これから)
```

## 設計方針

- **ログ本文は送らない**:個人情報を含みうるため、エージェントは本文を読み出さず、「1分 × プロセス × 重要度 の件数」だけを送る
- **取りこぼさない**:エージェントはどこまで送ったかをチェックポイントに記録し、送信に成功したときだけ進める。止まっていた場合は再起動時に続きから送る(最大1時間遡る)
- **何度届いても同じ結果**:サーバーは同じ (端末, 分, プロセス, 重要度) を足し込まず置き換えで保存するので、再送で件数が水増しされない
- **トークンは平文で持たない**:サーバーにはハッシュだけを保存する。エージェントには環境変数で渡し、コマンド引数(他のユーザーから見える)には出さない

## 構成

| ディレクトリ | 内容 |
|---|---|
| `agent/` | 収集エージェント(Swift、OSLogStore)。管理者ユーザーで実行する |
| `server/` | 受信API(Next.js 16 + Prisma + PostgreSQL) |

## 動かし方

PostgreSQL を用意する。

```bash
brew install postgresql@18
brew services start postgresql@18
createdb logwatch
createdb logwatch_test
```

サーバーを起動し、端末を登録する(表示されたトークンを控える)。

```bash
cd server
npm install
echo "DATABASE_URL=\"postgresql://$USER@localhost:5432/logwatch\"" > .env
npx prisma migrate dev
npm run dev
npm run host:add -- my-mac
```

エージェントを動かす。

```bash
cd agent
swift build -c release
LOGWATCH_TOKEN=<控えたトークン> .build/release/logwatch-agent --endpoint http://localhost:3000/api/ingest
```

`--endpoint` を省略すると、集計結果を標準出力に NDJSON で書き出す。

## テスト

```bash
cd agent && swift test
cd server && npm test   # logwatch_test データベースを使う
```
