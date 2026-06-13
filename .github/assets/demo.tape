# Hero: cd into a workspace and you are the right identity. The git commit email
# and GITHUB_TOKEN flip per directory, and clear outside any workspace.
# Render from the repo root: vhs .github/assets/demo.tape
Output .github/assets/demo.gif

Require node

Set Shell zsh
Set FontSize 18
Set FontFamily "Berkeley Mono"
Set Width 1280
Set Height 640
Set Padding 22
Set Theme { "name": "GitHub Dark", "background": "#101216", "foreground": "#e6edf3", "black": "#000000", "red": "#f78166", "green": "#56d364", "yellow": "#e3b341", "blue": "#6ca4f8", "magenta": "#db61a2", "cyan": "#39c5cf", "white": "#ffffff", "brightBlack": "#4d4d4d", "brightRed": "#f78166", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#6ca4f8", "brightMagenta": "#db61a2", "brightCyan": "#56d4dd", "brightWhite": "#ffffff", "cursor": "#c9d1d9", "selection": "#3b5070" }
Set TypingSpeed 60ms

Hide
Type "source .github/assets/setup-seeded.sh" Enter
Sleep 3s
Type "source ~/.config/inscope/inscope.zsh" Enter
Type "cd ~" Enter
Type "clear" Enter
Show

Sleep 800ms
Type "cd ~/acme" Sleep 200ms Enter
Sleep 900ms
Type "git config user.email" Sleep 200ms Enter
Sleep 1500ms
Type 'echo "token ${GITHUB_TOKEN:+loaded for this workspace}"' Sleep 200ms Enter
Sleep 2000ms

Type "cd ~/personal" Sleep 200ms Enter
Sleep 900ms
Type "git config user.email" Sleep 200ms Enter
Sleep 1500ms
Type 'echo "token ${GITHUB_TOKEN:+loaded for this workspace}"' Sleep 200ms Enter
Sleep 2000ms

Type "cd ~" Sleep 200ms Enter
Sleep 800ms
Type 'echo "token ${GITHUB_TOKEN:-cleared outside any workspace}"' Sleep 200ms Enter
Sleep 2800ms
