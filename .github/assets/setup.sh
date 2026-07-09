# Sandbox for recording the inscope demo GIFs (zsh). Run vhs from the repo root.
# Never touches your real ~/.config or ~/.zshrc, and stubs `gh` so only safe
# account names show up (no real tokens). See .github/assets/*.tape.
export SB="/tmp/inscope-demo"
rm -rf "$SB"
mkdir -p "$SB"
export HOME="$SB"
export XDG_CONFIG_HOME="$SB/.config"
export USER="neeraj" # so keychain hints show a safe name, not the real macOS user

# A personal global git identity, so `add`'s prompts show "global: <value>"; the
# work workspace then overrides the email per the demo.
git config --global user.email "neeraj@personal.com"
git config --global user.name "Neeraj Dalal"

mkdir -p "$SB/bin"
cat > "$SB/bin/gh" <<'GH'
#!/bin/bash
case "$1 $2" in
  "auth status")
    echo "github.com"
    echo "  * Logged in to github.com account neeraj-personal (keyring)"
    echo "  * Logged in to github.com account neeraj-work (keyring)"
    echo "  * Logged in to github.com account neeraj-acme (keyring)" ;;
  "auth token") echo "gho_demo_token" ;;
  *) echo "neeraj-personal" ;;
esac
exit 0
GH
chmod +x "$SB/bin/gh"
export PATH="$SB/bin:$PATH"

INSCOPE_BIN="$PWD/dist/bin/index.mjs"
inscope() { node "$INSCOPE_BIN" "$@"; }

cd ~
autoload -Uz add-zsh-hook
# blank line before the prompt; prompt + typed command render in cyan, reset to
# the default color before each command's output runs
PROMPT=$'\n%F{cyan}%~ ❯ '
__inscope_demo_reset() { print -n $'\e[0m' }
add-zsh-hook preexec __inscope_demo_reset
