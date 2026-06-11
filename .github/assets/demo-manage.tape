# Manage workspaces: list, interactive edit (add a server), rm with type-the-label
# confirm, list. Render from the repo root: vhs .github/assets/demo-manage.tape
Output .github/assets/demo-manage.gif

Require node

Set Shell zsh
Set FontSize 17
Set Width 1120
Set Height 860
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

Hide
Type "source .github/assets/setup-seeded.sh" Enter
Sleep 3s
Type "clear" Enter
Show

Sleep 800ms
Type "inscope list" Sleep 300ms Enter
Sleep 2800ms

Type "inscope edit acme" Sleep 300ms Enter
Sleep 1600ms
Enter
Sleep 1100ms
Enter
Sleep 1100ms
Enter
Sleep 1300ms
Down Sleep 500ms Space Sleep 800ms Enter
Sleep 2400ms

Type "inscope rm personal" Sleep 300ms Enter
Sleep 1600ms
Type "personal" Sleep 300ms Enter
Sleep 2200ms

Type "inscope list" Sleep 300ms Enter
Sleep 3000ms
