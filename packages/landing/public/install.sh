#!/usr/bin/env bash
set -euo pipefail

# Draht — 1-command installer
# Usage: curl -fsSL https://draht.dev/install.sh | bash

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}${BOLD}→${RESET} $*"; }
success() { echo -e "${GREEN}${BOLD}✓${RESET} $*"; }
error()   { echo -e "${RED}${BOLD}✗${RESET} $*" >&2; exit 1; }

echo ""
echo -e "${BOLD}  draht — AI coding agent for freelancers${RESET}"
echo -e "  ${CYAN}https://draht.dev${RESET}"
echo ""

# Install bun if needed
if ! command -v bun >/dev/null 2>&1; then
  info "bun not found — installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || error "bun installation failed. Install manually: https://bun.sh"
fi

# Install draht via bun
info "Installing @draht/coding-agent..."
bun add -g @draht/coding-agent || error "Installation failed."

echo ""
success "draht installed successfully!"
echo ""
echo -e "  ${BOLD}Usage:${RESET}"
echo -e "  ${CYAN}draht${RESET}                    — start interactive mode"
echo -e "  ${CYAN}draht -p \"your task\"${RESET}     — non-interactive mode"
echo -e "  ${CYAN}draht --help${RESET}             — show all options"
echo ""
echo -e "  ${BOLD}Docs:${RESET} https://draht.dev"
echo ""
