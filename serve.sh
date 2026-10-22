#!/usr/bin/env bash
# CodeNotes 本地静态服务
cd "$(dirname "$0")" || exit 1
PORT="${1:-8099}"
echo "CodeNotes → http://127.0.0.1:$PORT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
