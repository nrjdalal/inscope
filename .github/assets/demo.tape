# Hero demo: init, interactive add (gh picker + server multiselect), list, doctor.
# Render from the repo root: vhs .github/assets/demo.tape
Output .github/assets/demo.gif

Require node

Set Shell zsh
Set FontSize 17
Set Width 1120
Set Height 900
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 55ms

Hide
Type "source .github/assets/setup.sh" Enter
Type "clear" Enter
Show

Sleep 800ms
Type "inscope init" Sleep 300ms Enter
Sleep 2600ms

Type "inscope add ~/acme" Sleep 300ms Enter
Sleep 1500ms
Enter
Sleep 1500ms
Down Sleep 700ms Enter
Sleep 1300ms
Type "neeraj@acme.org" Sleep 300ms Enter
Sleep 1200ms
Enter
Sleep 1400ms
Down Sleep 220ms Down Sleep 220ms Down Sleep 220ms Down Sleep 220ms Down Sleep 220ms Down Sleep 450ms Space Sleep 800ms Enter
Sleep 2800ms

Type "inscope list" Sleep 300ms Enter
Sleep 3200ms

Type "inscope doctor" Sleep 300ms Enter
Sleep 3800ms

Sleep 1500ms
