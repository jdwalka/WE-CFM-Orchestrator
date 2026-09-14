#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${ROOT}/.codeql-results"
CONFIG="${ROOT}/.github/codeql/wecrypt-codeql.yml"
BASE_REF="${WECRYPTO_SCAN_BASE:-origin/main}"
FAIL_ON_FINDINGS="${WECRYPTO_SECURITY_SCAN_STRICT:-0}"

command -v codeql >/dev/null 2>&1 || {
  echo "CodeQL CLI is not installed."
  exit 1
}
command -v semgrep >/dev/null 2>&1 || {
  echo "Semgrep is not installed."
  exit 1
}

mkdir -p "${OUT}"
rm -rf "${OUT}/db" "${OUT}/db-javascript" "${OUT}/db-python" "${OUT}/python-src"

# Prefer PR-diff targets when a base ref is available.
mapfile -t TARGETS < <(
  git -C "${ROOT}" diff --name-only --diff-filter=ACMRTUXB "${BASE_REF}...HEAD" 2>/dev/null || true
)

while IFS= read -r file; do
  [[ -n "${file}" ]] && TARGETS+=("${file}")
done < <(git -C "${ROOT}" ls-files --others --exclude-standard)

if (( ${#TARGETS[@]} > 0 )); then
  mapfile -t TARGETS < <(printf '%s\n' "${TARGETS[@]}" | sort -u)
fi

FILTERED_TARGETS=()
for file in "${TARGETS[@]}"; do
  case "${file}" in
    WE-CRYPTO-CACHE/*|*.har) continue ;;
  esac
  [[ -f "${ROOT}/${file}" ]] && FILTERED_TARGETS+=("${file}")
done
TARGETS=("${FILTERED_TARGETS[@]}")

TARGETS_FILE="${OUT}/targets.txt"
printf '%s\n' "${TARGETS[@]}" > "${TARGETS_FILE}"

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "No changed files to scan."
  exit 0
fi

echo "Scanning ${#TARGETS[@]} changed file(s) against ${BASE_REF}."

# Semgrep: fast, PR-focused checks.
semgrep scan \
  --config p/owasp-top-ten \
  --config p/python \
  --config p/javascript \
  --exclude-rule typescript.react.security.react-insecure-request.react-insecure-request \
  --exclude node_modules \
  --exclude dist \
  --exclude build \
  --exclude coverage \
  --exclude .next \
  --exclude WE-CRYPTO-CACHE \
  --json \
  --json-output "${OUT}/semgrep.json" \
  "${TARGETS[@]}"

# CodeQL JavaScript: full semantic analysis against the repository source root.
codeql database create \
  "${OUT}/db-javascript" \
  --language=javascript-typescript \
  --build-mode=none \
  --source-root "${ROOT}" \
  --codescanning-config "${CONFIG}" \
  --overwrite

codeql database analyze \
  "${OUT}/db-javascript" \
  'codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls' \
  --format=sarifv2.1.0 \
  --output="${OUT}/javascript.sarif" \
  --download \
  --threads=0

# CodeQL Python: stage root-level modules into a temporary source root because
# the Python extractor's autobuild expects directory roots, not bare files.
PYTHON_SRC="${OUT}/python-src"
rm -rf "${PYTHON_SRC}"
mkdir -p "${PYTHON_SRC}"
python_file_count=0
for file in "${TARGETS[@]}"; do
  if [[ "${file}" == *.py ]]; then
    mkdir -p "${PYTHON_SRC}/$(dirname "${file}")"
    cp "${ROOT}/${file}" "${PYTHON_SRC}/${file}"
    python_file_count=$((python_file_count + 1))
  fi
done

if (( python_file_count > 0 )); then
  codeql database create \
    "${OUT}/db-python" \
    --language=python \
    --build-mode=none \
    --source-root "${PYTHON_SRC}" \
    --overwrite

  codeql database analyze \
    "${OUT}/db-python" \
    'codeql/python-queries:codeql-suites/python-code-scanning.qls' \
    --format=sarifv2.1.0 \
    --output="${OUT}/python.sarif" \
    --download \
    --threads=0
fi

echo "Semgrep report: ${OUT}/semgrep.json"
echo "CodeQL JavaScript report: ${OUT}/javascript.sarif"
if (( python_file_count > 0 )); then
  echo "CodeQL Python report: ${OUT}/python.sarif"
fi

if [[ "${FAIL_ON_FINDINGS}" == "1" ]]; then
  findings=$(python3 - <<'PY'
import json
from pathlib import Path

root = Path(".codeql-results")
targets = {
    line.strip()
    for line in (root / "targets.txt").read_text().splitlines()
    if line.strip()
}
target_findings = 0
total_findings = 0

semgrep_path = root / "semgrep.json"
if semgrep_path.exists():
    data = json.loads(semgrep_path.read_text())
    for result in data.get("results", []):
        total_findings += 1
        path = result.get("path", "")
        if path in targets:
            target_findings += 1

for name in ("javascript.sarif", "python.sarif"):
    path = root / name
    if not path.exists():
        continue
    data = json.loads(path.read_text())
    for run in data.get("runs", []):
        for result in run.get("results", []):
            total_findings += 1
            location = result.get("locations", [{}])[0]
            uri = (
                location.get("physicalLocation", {})
                .get("artifactLocation", {})
                .get("uri", "")
            )
            normalized = str(Path(uri)).replace("\\", "/")
            if normalized in targets:
                target_findings += 1

print(target_findings)
print(f"total_findings={total_findings}", file=__import__("sys").stderr)
PY
)
  if (( findings > 0 )); then
    echo "Security scan found ${findings} changed-file issue(s)."
    exit 1
  fi
fi
