#!/usr/bin/env bash
#
# Post-rebase verification suite for draht.
#
# Runs in order:
#   1. Branding integrity (no stale @draht/coding-agent-* refs)
#   2. bun install
#   3. Lint + type check (npm run check)
#   4. Build all packages
#   5. Unit tests (packages with test suites, skips e2e/API-dependent)
#
# Usage:
#   ./scripts/verify.sh          # full suite
#   ./scripts/verify.sh --quick  # skip tests, only install+check+build
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

QUICK=false
if [[ "${1:-}" == "--quick" ]]; then
    QUICK=true
fi

FAILED=0
PASSED=0
SKIPPED=0

step() {
    echo ""
    echo -e "${BOLD}[$((PASSED + FAILED + SKIPPED + 1))] $1${NC}"
}

pass() {
    echo -e "    ${GREEN}PASS${NC} $1"
    PASSED=$((PASSED + 1))
}

fail() {
    echo -e "    ${RED}FAIL${NC} $1"
    FAILED=$((FAILED + 1))
}

skip() {
    echo -e "    ${YELLOW}SKIP${NC} $1"
    SKIPPED=$((SKIPPED + 1))
}

# ── 1. Branding integrity ────────────────────────────────────────────
step "Branding integrity check"

STALE_REFS=$(grep -r "@draht/coding-agent-" packages/*/src/ packages/*/test/ packages/*/package.json \
    --include="*.ts" --include="*.json" -l 2>/dev/null | grep -v node_modules || true)

if [[ -z "$STALE_REFS" ]]; then
    pass "No stale @draht/coding-agent-* references in source"
else
    fail "Stale @draht/coding-agent-* references found:"
    echo "$STALE_REFS" | while read -r f; do
        echo "      $f"
    done
fi

# Check conflict markers
CONFLICT_MARKERS=$(grep -r "<<<<<<< HEAD\|>>>>>>> " packages/ --include="*.ts" --include="*.json" --include="*.md" -l 2>/dev/null | grep -v node_modules || true)

if [[ -z "$CONFLICT_MARKERS" ]]; then
    pass "No unresolved conflict markers"
else
    fail "Unresolved conflict markers found:"
    echo "$CONFLICT_MARKERS" | while read -r f; do
        echo "      $f"
    done
fi

# Check all package.json names use @draht/
BAD_PKG_NAMES=$(for f in packages/*/package.json; do
    name=$(grep '"name"' "$f" | head -1 | sed 's/.*"name": *"//;s/".*//')
    case "$name" in
        @draht/*|draht-*) ;;
        *) echo "$f: $name" ;;
    esac
done)

if [[ -z "$BAD_PKG_NAMES" ]]; then
    pass "All packages use @draht/ namespace"
else
    fail "Packages not using @draht/ namespace:"
    echo "$BAD_PKG_NAMES" | while read -r line; do
        echo "      $line"
    done
fi

# ── 2. Install dependencies ──────────────────────────────────────────
step "Install dependencies (bun install)"

if bun install 2>&1; then
    pass "bun install succeeded"
else
    fail "bun install failed"
    echo -e "    ${RED}Cannot continue without dependencies. Aborting.${NC}"
    exit 1
fi

# ── 3. Lint + type check ─────────────────────────────────────────────
step "Lint, format, type check (npm run check)"

if npm run check 2>&1; then
    pass "npm run check passed"
else
    fail "npm run check failed"
fi

# ── 4. Build all packages ────────────────────────────────────────────
step "Build all packages (npm run build)"

if npm run build 2>&1; then
    pass "npm run build passed"
else
    fail "npm run build failed"
fi

# ── 5. Unit tests ────────────────────────────────────────────────────
if [[ "$QUICK" == true ]]; then
    skip "Unit tests (--quick mode)"
else
    # Packages with unit tests that run without external services (no API keys, no Ollama).
    # Each test suite gets a 120s timeout to catch hangs.
    TEST_TIMEOUT=300

    # Core packages (pure unit tests, mocked where needed)
    CORE_TEST_PKGS=(tui coding-agent)
    # Additional packages (smaller test suites)
    EXTRA_TEST_PKGS=(compliance deploy-guardian invoice orchestrator router)
    # Skipped: ai and agent have mostly e2e/API tests that require credentials
    # Skipped: ci, knowledge have empty test suite files that vitest treats as errors

    for pkg in "${CORE_TEST_PKGS[@]}" "${EXTRA_TEST_PKGS[@]}"; do
        pkg_dir="packages/$pkg"
        if [[ ! -d "$pkg_dir" ]]; then
            continue
        fi

        test_script=$(node -e "const p=require('./$pkg_dir/package.json'); console.log(p.scripts?.test || '')" 2>/dev/null)
        if [[ -z "$test_script" ]]; then
            continue
        fi

        step "Tests: $pkg"

        if timeout "$TEST_TIMEOUT" bash -c "cd '$pkg_dir' && npm test" 2>&1; then
            pass "$pkg tests passed"
        else
            exit_code=$?
            if [[ $exit_code -eq 124 ]]; then
                fail "$pkg tests timed out (${TEST_TIMEOUT}s)"
            else
                fail "$pkg tests failed (exit $exit_code)"
            fi
        fi
    done
fi

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}Verification Summary${NC}"
echo -e "  ${GREEN}Passed:${NC}  $PASSED"
echo -e "  ${RED}Failed:${NC}  $FAILED"
echo -e "  ${YELLOW}Skipped:${NC} $SKIPPED"
echo -e "${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"

if [[ $FAILED -gt 0 ]]; then
    echo -e "${RED}Verification failed.${NC}"
    exit 1
else
    echo -e "${GREEN}Verification passed.${NC}"
    exit 0
fi
