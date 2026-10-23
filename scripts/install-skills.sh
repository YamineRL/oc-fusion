#!/usr/bin/env bash
# Install third-party skills for opencode, pinned to a reviewed commit.
# cloudflare/security-audit-skill (MIT) -> ~/.config/opencode/skills/security-audit
set -euo pipefail
REPO=https://github.com/cloudflare/security-audit-skill
REV=${SECURITY_AUDIT_REV:-c1c8a8c1471069fb0e188eeaff69b8e8db6564a8}
DEST=${OPENCODE_SKILLS_DIR:-$HOME/.config/opencode/skills}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" fetch -q --depth 1 "$REPO" "$REV"
git -C "$tmp" checkout -q FETCH_HEAD
mkdir -p "$DEST"
rm -rf "$DEST/security-audit.new"
cp -r "$tmp/skills/security-audit" "$DEST/security-audit.new"
cp "$tmp/LICENSE" "$DEST/security-audit.new/LICENSE"
rm -rf "$DEST/security-audit"
mv "$DEST/security-audit.new" "$DEST/security-audit"
echo "security-audit installed at $DEST/security-audit ($REV)"
