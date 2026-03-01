#!/usr/bin/env bash
set -euo pipefail

# Draht — 1-command installer
# Usage: curl -fsSL https://draht.dev/install.sh | bash

REPO="https://github.com/draht-dev/draht.git"
INSTALL_DIR="${DRAHT_DIR:-$HOME/.draht}"
BIN_DIR="${DRAHT_BIN:-$HOME/.local/bin}"

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

# Check dependencies
command -v git >/dev/null 2>&1  || error "git is required but not installed."
command -v curl >/dev/null 2>&1 || error "curl is required but not installed."

if ! command -v bun >/dev/null 2>&1; then
  info "bun not found — installing bun..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || error "bun installation failed. Install manually: https://bun.sh"
fi

# Guard against dangerous INSTALL_DIR values
case "$INSTALL_DIR" in
  /|/usr|/usr/local|/etc|/var|/tmp|"$HOME")
    error "Refusing to install to $INSTALL_DIR — set DRAHT_DIR to a safe location." ;;
esac

# Clone or update
if [ -d "$INSTALL_DIR/.git" ]; then
  info "Updating existing install at $INSTALL_DIR..."
  git -C "$INSTALL_DIR" fetch origin main --quiet
  git -C "$INSTALL_DIR" reset --hard origin/main
elif [ -d "$INSTALL_DIR" ]; then
  info "Removing existing $INSTALL_DIR (not a git repo)..."
  rm -rf "$INSTALL_DIR"
  info "Cloning draht to $INSTALL_DIR..."
  git clone --depth 1 "$REPO" "$INSTALL_DIR" --quiet
else
  info "Cloning draht to $INSTALL_DIR..."
  git clone --depth 1 "$REPO" "$INSTALL_DIR" --quiet
fi

# Build
info "Installing dependencies..."
cd "$INSTALL_DIR"
bun install

info "Building coding-agent..."
cd packages/tui && bun run build || error "Build failed (tui)."
cd "$INSTALL_DIR"
cd packages/ai && bun run build || error "Build failed (ai)."
cd "$INSTALL_DIR"
cd packages/agent && bun run build || error "Build failed (agent)."
cd "$INSTALL_DIR"
cd packages/coding-agent && bun run build || error "Build failed (coding-agent)."
cd "$INSTALL_DIR"

# Link binary
mkdir -p "$BIN_DIR"
BINARY="$INSTALL_DIR/packages/coding-agent/dist/cli.js"

if [ -f "$BINARY" ]; then
  # Create wrapper script
  cat > "$BIN_DIR/draht" <<EOF
#!/usr/bin/env bash
exec bun "$BINARY" "\$@"
EOF
  chmod +x "$BIN_DIR/draht"
else
  error "Build failed — $BINARY not found."
fi

# Add to PATH if needed
if ! echo "$PATH" | grep -q "$BIN_DIR"; then
  SHELL_RC=""
  case "$SHELL" in
    */zsh)  SHELL_RC="$HOME/.zshrc" ;;
    */bash) SHELL_RC="$HOME/.bashrc" ;;
    */fish) SHELL_RC="$HOME/.config/fish/config.fish" ;;
  esac

  if [ -n "$SHELL_RC" ]; then
    # Don't append if already present in the rc file
    if [ -f "$SHELL_RC" ] && grep -q "# draht" "$SHELL_RC"; then
      : # Already configured
    elif [ "$SHELL_RC" = "$HOME/.config/fish/config.fish" ]; then
      mkdir -p "$(dirname "$SHELL_RC")"
      echo "" >> "$SHELL_RC"
      echo "# draht" >> "$SHELL_RC"
      echo "set -gx PATH $BIN_DIR \$PATH" >> "$SHELL_RC"
      echo ""
      success "Added $BIN_DIR to PATH in $SHELL_RC"
      echo -e "  ${CYAN}Run: source $SHELL_RC${RESET}"
    else
      echo "" >> "$SHELL_RC"
      echo "# draht" >> "$SHELL_RC"
      echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
      echo ""
      success "Added $BIN_DIR to PATH in $SHELL_RC"
      echo -e "  ${CYAN}Run: source $SHELL_RC${RESET}"
    fi
  else
    echo ""
    info "Add $BIN_DIR to your PATH to use draht:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
  fi
fi

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
