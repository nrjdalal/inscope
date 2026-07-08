# inscope diff: preview drift as a colored diff, then --adopt back-syncs an
# on-disk setting into the config so the next apply keeps it.
# Render from the repo root: vhs .github/assets/diff.tape
Output .github/assets/diff.gif

Require node

Set Shell zsh
Set FontSize 18
Set FontFamily "Berkeley Mono"
Set Width 1280
Set Height 640
Set Padding 22
Set Theme { "name": "GitHub Dark", "background": "#101216", "foreground": "#e6edf3", "black": "#000000", "red": "#f78166", "green": "#56d364", "yellow": "#e3b341", "blue": "#6ca4f8", "magenta": "#db61a2", "cyan": "#39c5cf", "white": "#ffffff", "brightBlack": "#4d4d4d", "brightRed": "#f78166", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#6ca4f8", "brightMagenta": "#db61a2", "brightCyan": "#56d4dd", "brightWhite": "#ffffff", "cursor": "#c9d1d9", "selection": "#3b5070" }
Set TypingSpeed 55ms

Hide
Type "source .github/assets/setup.sh" Enter
Type "mkdir -p ~/.config/inscope ~/acme" Enter
Type `printf '%s' '{"version":1,"workspaces":[{"name":"acme","path":"~/acme","gh":"nrjdalal","servers":{"github":true,"slack":{"keychain":"SLACK_MCP_XOXP_TOKEN_ACME"}}}]}' > ~/.config/inscope/inscope.json` Enter
Type "inscope apply" Enter
Type "clear" Enter
Show

Sleep 800ms
# in sync: apply would change nothing
Type "inscope diff" Sleep 300ms Enter
Sleep 2400ms

# you allow Slack to post by removing the fork's read-only opt-out in .mcp.json (drift)
Hide
Type `node -e 'f=process.env.HOME+"/acme/.mcp.json";d=require(f);delete d.mcpServers["slack-acme"].env.SLACK_MCP_ALLOW_WRITE;require("fs").writeFileSync(f,JSON.stringify(d,null,2)+"\n")'` Enter
Type "clear" Enter
Show

Sleep 600ms
# diff shows apply would put the opt-out back, and offers to keep your change
Type "inscope diff" Sleep 300ms Enter
Sleep 3600ms

# back-sync the on-disk setting into the config
Type "inscope diff --adopt" Sleep 300ms Enter
Sleep 2600ms

# apply from the updated config, then confirm in sync
Type "inscope apply" Sleep 300ms Enter
Sleep 1500ms
Type "inscope diff" Sleep 300ms Enter
Sleep 2800ms

Sleep 1500ms
