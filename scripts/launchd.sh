#!/bin/bash
# logwatch のサーバー・エージェント・PCA ワーカーを launchd で常駐させる(ログイン時に自動起動、落ちたら再起動)。
#
#   LOGWATCH_TOKEN=<端末のトークン> scripts/launchd.sh install
#   scripts/launchd.sh status
#   scripts/launchd.sh uninstall
#
# PostgreSQL は別途 `brew services start postgresql@18` で常駐させておく。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/logwatch"
PORT="${LOGWATCH_PORT:-3001}"
DOMAIN="gui/$(id -u)"
LABELS=(com.logwatch.server com.logwatch.agent com.logwatch.detector)

plist_path() { echo "$AGENTS_DIR/$1.plist"; }

# $1=label, $2=作業ディレクトリ, $3=環境変数の <dict> の中身, 残り=実行するコマンドと引数
write_plist() {
  local label="$1" workdir="$2" env="$3"
  shift 3
  local args=""
  for a in "$@"; do args+="    <string>$a</string>"$'\n'; done
  local path
  path="$(plist_path "$label")"
  # エージェントのトークンを含むため、本人だけが読める権限で作る
  (umask 077 && cat > "$path" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
$args  </array>
  <key>WorkingDirectory</key>
  <string>$workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
$env  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/${label#com.logwatch.}.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/${label#com.logwatch.}.log</string>
</dict>
</plist>
EOF
  )
  chmod 600 "$path"
}

env_entry() { printf '    <key>%s</key>\n    <string>%s</string>\n' "$1" "$2"; }

# bootout は解除の完了を待たずに戻るため、続けて bootstrap すると失敗することがある
unload() {
  launchctl bootout "$DOMAIN/$1" 2>/dev/null || true
  for _ in $(seq 1 50); do
    launchctl print "$DOMAIN/$1" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "$1 の停止を確認できませんでした。" >&2
  return 1
}

install() {
  : "${LOGWATCH_TOKEN:?環境変数 LOGWATCH_TOKEN に端末のトークンを設定してください(npm run host:add で発行)}"
  local node_dir
  node_dir="$(dirname "$(command -v node)")"
  local database_url="postgresql://$USER@localhost:5432/logwatch"
  local path_env="$node_dir:/opt/homebrew/bin:/usr/bin:/bin"

  echo "ビルドしています..."
  (cd "$REPO/agent" && swift build -c release >/dev/null)
  (cd "$REPO/server" && npm run build >/dev/null)
  [ -x "$REPO/detector/.venv/bin/python" ] || {
    echo "detector/.venv がありません。README の手順で作成してください。" >&2
    exit 1
  }

  mkdir -p "$AGENTS_DIR" "$LOG_DIR"

  # ダッシュボードには認証がないため、同じネットワークの他の端末からは見えないよう自分自身だけで待ち受ける
  write_plist com.logwatch.server "$REPO/server" \
    "$(env_entry PATH "$path_env")$(env_entry NODE_ENV production)" \
    "$node_dir/node" "$REPO/server/node_modules/next/dist/bin/next" start -H 127.0.0.1 -p "$PORT"

  write_plist com.logwatch.agent "$REPO/agent" \
    "$(env_entry LOGWATCH_TOKEN "$LOGWATCH_TOKEN")" \
    "$REPO/agent/.build/release/logwatch-agent" --endpoint "http://127.0.0.1:$PORT/api/ingest"

  write_plist com.logwatch.detector "$REPO/detector" \
    "$(env_entry DATABASE_URL "$database_url")$(env_entry PYTHONUNBUFFERED 1)" \
    "$REPO/detector/.venv/bin/python" -m logwatch_detector.worker

  for label in "${LABELS[@]}"; do
    unload "$label"
    launchctl bootstrap "$DOMAIN" "$(plist_path "$label")"
  done
  echo "常駐させました。ダッシュボード: http://127.0.0.1:$PORT  ログ: $LOG_DIR"
}

uninstall() {
  for label in "${LABELS[@]}"; do
    unload "$label"
    rm -f "$(plist_path "$label")"
  done
  echo "常駐を解除しました(ログ $LOG_DIR と DB のデータは残しています)。"
}

status() {
  for label in "${LABELS[@]}"; do
    if info="$(launchctl print "$DOMAIN/$label" 2>/dev/null)"; then
      state="$(awk -F' = ' '/^\tstate/ {print $2; exit}' <<<"$info")"
      pid="$(awk -F' = ' '/^\tpid/ {print $2; exit}' <<<"$info")"
      echo "$label: ${state:-?} (pid ${pid:--})"
    else
      echo "$label: 登録されていません"
    fi
    tail -n 2 "$LOG_DIR/${label#com.logwatch.}.log" 2>/dev/null | sed 's/^/    /'
  done
}

case "${1:-}" in
  install) install ;;
  uninstall) uninstall ;;
  status) status ;;
  *) echo "使い方: $0 install|uninstall|status" >&2; exit 2 ;;
esac
