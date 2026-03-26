#!/usr/bin/env bash
set -euo pipefail
URL="${1:-http://127.0.0.1:3000/login}"
code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)
if [[ "$code" == "200" || "$code" == "302" || "$code" == "307" ]]; then
  echo "healthy ($code)"
  exit 0
fi
echo "unhealthy ($code)"
exit 1
