# `inscope status`: the full identity resolved for the current directory. The
# shared login in ~/personal and ~/work (different GitHub + git email), then a
# client on its own isolated login + subscription in ~/clients/acme.
# Render from the repo root: vhs .github/assets/status.tape
Output .github/assets/status.gif

Require node

Set Shell zsh
Set FontSize 18
Set FontFamily "Berkeley Mono"
Set Width 1280
Set Height 814
Set Padding 22
Set Theme { "name": "GitHub Dark", "background": "#101216", "foreground": "#e6edf3", "black": "#000000", "red": "#f78166", "green": "#56d364", "yellow": "#e3b341", "blue": "#6ca4f8", "magenta": "#db61a2", "cyan": "#39c5cf", "white": "#ffffff", "brightBlack": "#4d4d4d", "brightRed": "#f78166", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#6ca4f8", "brightMagenta": "#db61a2", "brightCyan": "#56d4dd", "brightWhite": "#ffffff", "cursor": "#c9d1d9", "selection": "#3b5070" }
Set TypingSpeed 55ms

Hide
Type "source .github/assets/setup-status.sh" Enter
Sleep 4s
Type "source ~/.config/inscope/inscope.zsh" Enter
Type "cd ~" Enter
Type "clear" Enter
Show

Sleep 700ms
Type "cd ~/personal && inscope status" Sleep 200ms Enter
Sleep 2000ms

Type "cd ~/work && inscope status" Sleep 200ms Enter
Sleep 2000ms

Type "cd ~/clients/acme && inscope status" Sleep 200ms Enter
Sleep 7s
