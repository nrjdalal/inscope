# Plan: sign-in on machines without Chrome

Status: planned, later.

## Today

`inscope login` and `inscope proxy login` open Anthropic's sign-in page in a new Chrome window on a fresh profile, and the user signs in there with nothing pre-filled. Without a Chrome-family browser, the only choices are `--browser system` (the default browser, with its existing cookies, so not a fresh session) or `--browser none` (print the URL).

## Plan

- Don't assume Chrome: some machines only have Safari.
- Offer a clean-session sign-in in Safari, for example a private window. `open -a Safari` cannot ask for one, so this needs AppleScript UI scripting, which in turn needs Accessibility permission.
- When no isolated option exists, say so plainly and explain what the user gives up.
