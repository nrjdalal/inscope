# Sandbox for the `inscope status` recording (zsh). Seeds three workspaces:
# personal and work on the shared login, and a client (acme) on its own isolated
# login. Stubs `gh` + `claude` so only safe demo accounts appear, never a real
# token or a real Claude login.
export SB="/tmp/inscope-status-demo"
rm -rf "$SB"
mkdir -p "$SB"
# Resolve to the physical path: on macOS /tmp is a symlink to /private/tmp, and
# `inscope status` matches the workspace against Node's cwd (which is physical),
# so HOME must be physical too or every dir reads as "no workspace".
export SB="$(cd "$SB" && pwd -P)"
export HOME="$SB"
export XDG_CONFIG_HOME="$SB/.config"
unset CLAUDE_CONFIG_DIR

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

# `inscope status` runs `claude auth status --json` with CLAUDE_CONFIG_DIR pinned
# to the login it would use here; the stub keys off that dir to show the isolated
# client's own account vs the shared base account.
cat > "$SB/bin/claude" <<'CLAUDE'
#!/bin/bash
if [ "$1 $2 $3" = "auth status --json" ]; then
  case "$CLAUDE_CONFIG_DIR" in
    */work/.inscope) echo '{"loggedIn":true,"email":"neeraj@work.com","subscriptionType":"team","orgName":"Work Org"}' ;;
    */clients/acme/.inscope) echo '{"loggedIn":true,"email":"neeraj@acme.org","subscriptionType":"team","orgName":"Acme Inc"}' ;;
    *) echo '{"loggedIn":true,"email":"neeraj@personal.com","subscriptionType":"max"}' ;;
  esac
fi
exit 0
CLAUDE
chmod +x "$SB/bin/claude"
export PATH="$SB/bin:$PATH"

git config --global user.email "neeraj@personal.com"
git config --global init.defaultBranch main

INSCOPE_BIN="$PWD/dist/bin/index.mjs"
inscope() { node "$INSCOPE_BIN" "$@"; }

inscope add ~/personal --gh neeraj-personal --email neeraj@personal.com --servers github -y >/dev/null
inscope add ~/work --gh neeraj-work --email neeraj@work.com --servers github,linear --isolate -y >/dev/null
inscope add ~/clients/acme --gh neeraj-acme --email neeraj@acme.org --servers github,linear,notion --isolate -y >/dev/null
git -C ~/personal init -q
git -C ~/work init -q
git -C ~/clients/acme init -q

cd ~
autoload -Uz add-zsh-hook
PROMPT=$'\n%F{cyan}%~ ❯ '
__inscope_demo_reset() { print -n $'\e[0m' }
add-zsh-hook preexec __inscope_demo_reset
