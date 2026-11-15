#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPORT_DIR="$ROOT_DIR/.blind-export/veritas-blind-repo"

rm -rf "$EXPORT_DIR"
mkdir -p "$EXPORT_DIR"

rsync -a --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='.next/' \
  --exclude='.data/' \
  --exclude='.blind-export/' \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.pytest_cache/' \
  --exclude='*.tsbuildinfo' \
  --exclude='.DS_Store' \
  --exclude='.env*' \
  --exclude='ml/weights/*.onnx' \
  --exclude='scripts/prepare_blind_submission.sh' \
  "$ROOT_DIR/" "$EXPORT_DIR/"

cd "$EXPORT_DIR"

# Scrub any /Users/... metadata or embedded paths from notebooks if present
for nb in notebooks/*.ipynb; do
  if [ -f "$nb" ]; then
    python3 -c '
import json, pathlib, re, sys
p = pathlib.Path(sys.argv[1])
raw = p.read_text(encoding="utf-8")
cleaned = re.sub(r"/Users/[^/\"\s\\\\]+", "/workspace", raw)
if cleaned != raw:
    p.write_text(cleaned, encoding="utf-8")
' "$nb"
  fi
done

git init -b main >/dev/null 2>&1 || {
  git init >/dev/null
  git checkout -b main >/dev/null
}

export GIT_AUTHOR_NAME="Climate Graph Team"
export GIT_AUTHOR_EMAIL="anonymous@example.com"
export GIT_COMMITTER_NAME="Climate Graph Team"
export GIT_COMMITTER_EMAIL="anonymous@example.com"

git config user.name "Climate Graph Team"
git config user.email "anonymous@example.com"

git add -A
git commit -m "Initial anonymized blind-review submission" >/dev/null

PII_PATTERN="Sam Wu|ShamWuo|wuruosen|swum|/Users/|@gmail\\.|@.*\\.edu"

echo "[blind-export] Scanning exported files, git metadata, and PDFs for PII..."
FILE_HITS="$(grep -rnEI "$PII_PATTERN" --exclude-dir=.git . || true)"
LOG_HITS="$(git log --format=fuller -n 5 | grep -nEI "$PII_PATTERN" || true)"

UV_BIN="$(command -v uv || true)"
if [ -z "$UV_BIN" ] && [ -x "/Users/swum/.local/bin/uv" ]; then
  UV_BIN="/Users/swum/.local/bin/uv"
fi
PDF_HITS=""
if compgen -G "deliverables/*.pdf" >/dev/null && [ -n "$UV_BIN" ]; then
  PDF_HITS="$(PII_CHECK_PATTERN="$PII_PATTERN" "$UV_BIN" run --with pypdf python3 -c '
import os, pathlib, re
from pypdf import PdfReader
pat = re.compile(os.environ["PII_CHECK_PATTERN"], re.IGNORECASE)
for pdf_path in sorted(pathlib.Path("deliverables").glob("*.pdf")):
    r = PdfReader(str(pdf_path))
    txt = "\n".join((p.extract_text() or "") for p in r.pages)
    meta = " ".join(f"{k}:{v}" for k, v in (r.metadata or {}).items())
    hits = pat.findall(txt + "\n" + meta)
    if hits:
        print(f"{pdf_path}: {hits[:5]}")
')"
fi

if [ -n "$FILE_HITS" ] || [ -n "$LOG_HITS" ] || [ -n "$PDF_HITS" ]; then
  echo "[blind-export] ERROR: PII detected in exported blind repository!" >&2
  [ -n "$FILE_HITS" ] && echo "$FILE_HITS" >&2
  [ -n "$LOG_HITS" ] && echo "$LOG_HITS" >&2
  [ -n "$PDF_HITS" ] && echo "$PDF_HITS" >&2
  exit 1
fi

COMMIT_COUNT="$(git rev-list --count HEAD)"
FILE_COUNT="$(git ls-files | wc -l | tr -d ' ')"

echo "[blind-export] OK: clean blind-review mirror created at $EXPORT_DIR"
echo "[blind-export] Commits: $COMMIT_COUNT | Tracked files: $FILE_COUNT | Author: $(git log -1 --format='%an <%ae>') | PII matches: 0"
