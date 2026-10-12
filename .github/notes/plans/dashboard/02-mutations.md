# Mutations

**Status:** parked.

The dashboard only reads. Running `apply`, `diff --adopt`, or `skill update`
from it would change files under HOME, so a write needs more than the read
gate:

- `requireLocal` already refuses a non-read method without a trusted Origin;
  that stays.
- A token minted per launch of the stack, handed to the page and required on
  every write, so a page that is not the dashboard cannot write even from
  loopback.
- Each route shows what it would change (the same redacted diff) and acts only
  on an explicit confirm.
