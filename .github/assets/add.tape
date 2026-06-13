# inscope add: interactively map a directory to a gh account, git identity, and
# MCP servers. Here it includes Slack, with its keychain and Yes/No prompts.
# Render from the repo root: vhs .github/assets/add.tape
Output .github/assets/add.gif

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
Type "inscope init" Enter
Type "clear" Enter
Show

Sleep 800ms
Type "inscope add ~/acme" Sleep 300ms Enter
Sleep 1500ms
Enter
Sleep 1200ms
Down Sleep 400ms Enter
Sleep 1200ms
Type "neeraj@acme.org" Sleep 300ms Enter
Sleep 1100ms
Enter
Sleep 1300ms
Up Sleep 200ms Up Sleep 200ms Up Sleep 200ms Up Sleep 500ms Space Sleep 900ms Enter
Sleep 1600ms
Enter
Sleep 1600ms
Enter
Sleep 1300ms
Down Sleep 800ms Enter
Sleep 2800ms

Type "inscope list" Sleep 300ms Enter
Sleep 3400ms
