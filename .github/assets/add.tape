# inscope add, two ways: bare `inscope add` maps the current directory (and sets
# up inscope on first run); `inscope add <path>` maps an explicit one (here with
# Slack and an isolated login). Render from the repo root: vhs .github/assets/add.tape
Output .github/assets/add.gif

Require node

Set Shell zsh
Set FontSize 18
Set FontFamily "Berkeley Mono"
Set Width 1280
Set Height 2600
Set Padding 22
Set Theme { "name": "GitHub Dark", "background": "#101216", "foreground": "#e6edf3", "black": "#000000", "red": "#f78166", "green": "#56d364", "yellow": "#e3b341", "blue": "#6ca4f8", "magenta": "#db61a2", "cyan": "#39c5cf", "white": "#ffffff", "brightBlack": "#4d4d4d", "brightRed": "#f78166", "brightGreen": "#56d364", "brightYellow": "#e3b341", "brightBlue": "#6ca4f8", "brightMagenta": "#db61a2", "brightCyan": "#56d4dd", "brightWhite": "#ffffff", "cursor": "#c9d1d9", "selection": "#3b5070" }
Set TypingSpeed 55ms

Hide
Type "source .github/assets/setup.sh" Enter
Type "mkdir -p ~/personal" Enter
Type "clear" Enter
Show

# 1) bare `inscope add` maps the directory you are in (first run sets up inscope)
Sleep 700ms
Type "cd ~/personal" Sleep 200ms Enter
Sleep 500ms
Type "inscope add" Sleep 300ms Enter
Sleep 1400ms
Enter
Sleep 1000ms
Enter
Sleep 1000ms
Enter
Sleep 1000ms
Enter
Sleep 900ms
Enter
Sleep 1000ms
Enter
Sleep 1200ms
Enter
Sleep 2600ms

# 2) `inscope add <path>` maps an explicit directory, here with Slack + isolation
Type "cd ~" Sleep 200ms Enter
Sleep 500ms
Type "inscope add ~/work" Sleep 300ms Enter
Sleep 1400ms
Enter
Sleep 1100ms
Down Sleep 400ms Enter
Sleep 1100ms
Type "neeraj@work.com" Sleep 300ms Enter
Sleep 1000ms
Enter
Sleep 1200ms
Up Sleep 200ms Up Sleep 200ms Up Sleep 200ms Up Sleep 500ms Space Sleep 900ms Enter
Sleep 1500ms
Sleep 500ms Enter
Sleep 1500ms
Enter
Sleep 1400ms
Enter
Sleep 1300ms
Down Sleep 400ms Enter
Sleep 1300ms
Up Sleep 400ms Enter
Sleep 2600ms

Type "inscope list" Sleep 300ms Enter
Sleep 7s
