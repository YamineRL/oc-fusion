#!/usr/bin/env bash
# Fail when a tracked file holds a private detail: a home directory path, a
# LAN or tailnet address, a private hostname or a key-shaped string. The repo
# is public. Allow one line with a trailing "privacy-scan: ok" comment.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
pat='(/home/[a-z][a-z0-9_-]*/|/Users/[A-Za-z][A-Za-z0-9_-]*/|\b192\.168\.[0-9]+\.[0-9]+|\b10\.[0-9]+\.[0-9]+\.[0-9]+\b|\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]+\.[0-9]+|\btailcat\b|\.ts\.net\b|\bsk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY)'
hits=$(git ls-files -z | grep -zv '^scripts/privacy-scan.sh$' \
  | xargs -0 grep -nIE "$pat" -- 2>/dev/null | grep -v 'privacy-scan: ok' || true)
if [ -n "$hits" ]; then
  printf '%s\n' "$hits"
  echo "privacy-scan: private details found (lines above)." >&2
  exit 1
fi
echo "privacy-scan: clean"
