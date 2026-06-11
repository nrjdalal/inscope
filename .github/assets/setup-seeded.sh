# Sandbox seeded with two workspaces, for the switch/manage demo recordings.
# Run vhs from the repo root. Never touches your real config; stubs `gh` so only
# safe account names appear and no real token is used.
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

# blank line before each prompt (bash uses PS1, zsh uses PROMPT)
export PS1=$'\n❯ '
export PROMPT=$'\n%~ ❯ '

INSCOPE_BIN="$PWD/dist/bin/index.mjs"
inscope() { node "$INSCOPE_BIN" "$@"; }

inscope init >/dev/null
inscope add ~/work --gh nrjdalal --email you@work.dev --servers github,linear -y >/dev/null
inscope add ~/personal --gh dalonic --email you@personal.dev --servers github -y >/dev/null
git -C ~/work init -q
git -C ~/personal init -q
