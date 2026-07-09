# Sandbox seeded with three workspaces (zsh), for the switch/manage recordings.
# Run vhs from the repo root. Never touches your real config; stubs `gh` so only
# safe account names appear and no real token is used. personal is on the shared
# login; work and acme (a client) are isolated.
export SB="/tmp/inscope-demo"
rm -rf "$SB"
mkdir -p "$SB"
export HOME="$SB"
export XDG_CONFIG_HOME="$SB/.config"
export USER="neeraj" # so keychain hints show a safe name, not the real macOS user

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

inscope init >/dev/null
inscope add ~/personal --gh neeraj-personal --email neeraj@personal.com --servers github -y >/dev/null
inscope add ~/work --gh neeraj-work --email neeraj@work.com --servers github,linear --isolate -y >/dev/null
inscope add ~/clients/acme --gh neeraj-acme --email neeraj@acme.org --servers github,linear,notion --isolate -y >/dev/null
git -C ~/personal init -q
git -C ~/work init -q
git -C ~/clients/acme init -q
# mark the isolated logins as signed in so `doctor` shows them green (a real
# login fills these dirs; the demo never stores a real token)
: > ~/work/.inscope/.credentials.json
: > ~/clients/acme/.inscope/.credentials.json

cd ~
autoload -Uz add-zsh-hook
PROMPT=$'\n%F{cyan}%~ ❯ '
__inscope_demo_reset() { print -n $'\e[0m' }
add-zsh-hook preexec __inscope_demo_reset
