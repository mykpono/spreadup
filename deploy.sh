#!/bin/bash
set -e

# SpreadUp — Deploy script
# Bumps version, commits, tags, and pushes to GitHub.
# Usage: ./deploy.sh [patch|minor|major]  (default: patch)

BUMP_TYPE=${1:-patch}
MANIFEST="manifest.json"

# ── 1. Pre-release check ───────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════"
echo "  SpreadUp — Pre-Release Deploy"
echo "═══════════════════════════════════════════════"
echo ""
echo "⚠️  Have you completed the pre-release checklist?"
echo "    → See PRERELEASE.md"
echo ""
read -p "Continue? (y/n) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 1
fi

# ── 2. Bump version in manifest.json ────────────────────────────────────────
CURRENT=$(grep '"version"' "$MANIFEST" | head -1 | sed 's/.*"\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/')
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case $BUMP_TYPE in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
  *) echo "Usage: ./deploy.sh [patch|minor|major]"; exit 1 ;;
esac

NEW_VERSION="$MAJOR.$MINOR.$PATCH"
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST"

echo "📦 Version: $CURRENT → $NEW_VERSION ($BUMP_TYPE)"

# ── 3. Stage, commit, tag ──────────────────────────────────────────────────
git add -A
git commit -m "$(cat <<EOF
Release v${NEW_VERSION}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"

git tag -a "v${NEW_VERSION}" -m "Release v${NEW_VERSION}"

# ── 4. Push to GitHub ──────────────────────────────────────────────────────
git push origin main --tags

echo ""
echo "✅ Deployed v${NEW_VERSION} and pushed to GitHub"
echo "   https://github.com/mykpono/spreadup/releases/tag/v${NEW_VERSION}"
echo ""
