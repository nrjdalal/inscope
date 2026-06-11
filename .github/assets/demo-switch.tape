# Identity switch on cd: git email + token flip per workspace, cleared outside.
# Render from the repo root: vhs .github/assets/demo-switch.tape
Output .github/assets/demo-switch.gif

Require node

Set Shell zsh
Set FontSize 17
Set Width 1120
Set Height 620
Set Padding 22
Set Theme "Catppuccin Mocha"
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
