# Glassdoor

Normal window. Open Glassdoor before Indeed. Issue #2 stays open for the driven browser.

| From | Option | To | Result |
|---|---|---|---|
| `https://www.glassdoor.com/profile/login_input.htm` | Continue with Google | signed-in Glassdoor | success |
| Indeed, after that Google sign-in | the same Google account | Indeed accepts the account | success |
| `https://www.glassdoor.com/Salaries/index.htm` | Browse jobs. Do not write a review or add a salary | `https://www.glassdoor.com/Job/index.htm` | success |
| `/Job/index.htm` | Apply on employer site | the company site | seen, not submitted |
| `/Job/index.htm` | Easy Apply | smartapply.indeed.com | refused |
| `/Job/index.htm` | — | Whitelabel Error Page | retry, not a login wall |
| debug window on Glassdoor | — | Humans only | stop |

The jobs list is the page that loaded. In-site Apply now on Glassdoor has not been submitted.

## Routing decision (implemented)

Glassdoor Pakistan listings are DISCOVERED but ROUTED as external/needs_manual: in-site Easy
Apply resolves to `smartapply.indeed.com` and is refused, so there is intentionally NO Glassdoor
submit channel. Indeed is the only real submitting path. If Glassdoor discovery is wired later it
must save leads with a non-`indeed_easy` channel (e.g. `form`/`connect`) so the applier never
attempts a fake Glassdoor submit.

| From | Option | To | Result |
|---|---|---|---|
| Glassdoor Pakistan job list | discovery only | lead routed needs_manual | no in-site submit |
