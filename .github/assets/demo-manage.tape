# Manage workspaces: list, interactive edit, rm with type-the-label confirm, list.
# Render from the repo root: vhs .github/assets/demo-manage.tape
Output .github/assets/demo-manage.gif

Require node

Set Shell bash
Set FontSize 18
Set Width 1120
Set Height 820
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
Sleep 2600ms

Type "inscope edit personal" Sleep 300ms Enter
Sleep 1600ms
Enter
Sleep 1300ms
Type "me@dal.com" Sleep 300ms Enter
Sleep 1100ms
Enter
Sleep 1300ms
Enter
Sleep 2400ms

Type "inscope rm work" Sleep 300ms Enter
Sleep 1600ms
Type "work" Sleep 300ms Enter
Sleep 2200ms

Type "inscope list" Sleep 300ms Enter
Sleep 3000ms
