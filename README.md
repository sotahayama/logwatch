# logwatch

Mac のシステムログを集め、平常時のパターンから外れた動きを検知する仕組み。

```
agent (Swift) ──1分ごとの件数──▶ server (Next.js) ──▶ PostgreSQL
                                     │
                                     ├─▶ 受信時に統計的な異常検知
                                     └─▶ ダッシュボード(30秒ごとに自動更新)
```

## 異常検知(統計的な方法)

「プロセス × 重要度」ごとに、直前60分(エージェントが動いていた分だけ)の件数の中央値とばらつき(MAD)を平常時とし、今の1分がどれだけ外れたかで判定する。

- **急増**:エラー・障害レベルの件数が、平常時のばらつきの6倍以上かつ20件以上増えた
- **沈黙**:平常時に毎分30件以上出すプロセスが0件になった(端末全体が静かな分は除く)

最初は全レベルを対象にしていたが、実データでは「放置→作業開始」だけで30分に約1,400件のアラートが出て、その9割以上が情報・通知レベルだった。使い方で平常時そのものが変わるため、急増はエラー・障害に絞った(約85件に減少)。平常時の変化に追従するのは統計的な方法の限界で、次の段階の機械学習で扱う。

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
