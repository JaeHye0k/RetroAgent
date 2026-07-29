#!/usr/bin/env bash
# 회고 에이전트를 로그인 시 자동 실행되는 launchd 서비스로 등록한다.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.retro-agent.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "❌ $ROOT/.env 가 없습니다. .env.example 을 복사해 값을 채워주세요." >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" ]]; then
  echo "❌ node 를 찾을 수 없습니다." >&2
  exit 1
fi

# claude CLI 가 PATH 에 있어야 정리 단계가 동작한다.
CLAUDE_BIN="$(command -v claude || true)"
if [[ -z "$CLAUDE_BIN" ]]; then
  echo "⚠️  claude 를 PATH 에서 찾지 못했습니다. .env 의 CLAUDE_BIN 에 전체 경로를 적어주세요."
fi

mkdir -p "$ROOT/data/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>--env-file=$ROOT/.env</string>
    <string>$ROOT/src/index.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>TZ</key>
    <string>Asia/Seoul</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>$ROOT/data/logs/agent.log</string>
  <key>StandardErrorPath</key>
  <string>$ROOT/data/logs/agent.error.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "✅ 등록했습니다: $PLIST"
echo
echo "   상태 확인 : launchctl print gui/$(id -u)/$LABEL | head -20"
echo "   로그 보기 : tail -f $ROOT/data/logs/agent.log"
echo "   해제      : bash $ROOT/scripts/uninstall-launchd.sh"
