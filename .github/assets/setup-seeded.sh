# Sandbox seeded with two workspaces (zsh), for the switch/manage recordings.
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
    echo "  * Logged in to github.com account neeraj-acme-org (keyring)" ;;
  "auth token") echo "gho_demo_token" ;;
  *) echo "nrjdalal" ;;
esac
exit 0
GH
chmod +x "$SB/bin/gh"
export PATH="$SB/bin:$PATH"

INSCOPE_BIN="$PWD/dist/bin/index.mjs"
inscope() { node "$INSCOPE_BIN" "$@"; }

inscope init >/dev/null
inscope add ~/acme --gh neeraj-acme-org --email neeraj@acme.org --servers github,linear -y >/dev/null
inscope add ~/personal --gh nrjdalal --email hello@nrjdalal.com --servers github -y >/dev/null
git -C ~/acme init -q
git -C ~/personal init -q

cd ~
autoload -Uz add-zsh-hook
PROMPT=$'\n%F{cyan}%~ ❯ '
__inscope_demo_reset() { print -n $'\e[0m' }
add-zsh-hook preexec __inscope_demo_reset
