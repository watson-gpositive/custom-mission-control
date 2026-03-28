#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

export HOSTNAME="${HOSTNAME:-0.0.0.0}"
exec npx next start --hostname 0.0.0.0 --port 3000
