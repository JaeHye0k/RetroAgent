#!/usr/bin/env bash
set -euo pipefail

LABEL="com.retro-agent.daily"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

echo "✅ 해제했습니다. (data/ 의 큐와 로그는 그대로 둡니다)"
