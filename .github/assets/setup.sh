# Sandbox for recording the inscope demo GIFs. Run vhs from the repo root.
# Never touches your real ~/.config or ~/.zshrc, and stubs `gh` so only safe
# account names show up (no real tokens). See .github/assets/*.tape.
export SB="/tmp/inscope-demo"
rm -rf "$SB"
mkdir -p "$SB"
export HOME="$SB"
export XDG_CONFIG_HOME="$SB/.config"

mkdir -p "$SB/bin"
cat > "$SB/bin/gh" <<'GH'
#!/bin/bash
case "$1 $2" in
  "auth status")
    echo "github.com"
    echo "  * Logged in to github.com account nrjdalal (keyring)"
    echo "  * Logged in to github.com account dalonic (keyring)" ;;
  "auth token") echo "gho_demo_token" ;;
  *) echo "nrjdalal" ;;
esac
exit 0
GH
chmod +x "$SB/bin/gh"
export PATH="$SB/bin:$PATH"

# blank line before each prompt for readable spacing between commands
export PS1=$'\n❯ '

INSCOPE_BIN="$PWD/dist/bin/index.mjs"
inscope() { node "$INSCOPE_BIN" "$@"; }
