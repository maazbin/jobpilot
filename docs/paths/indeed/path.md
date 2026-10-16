# Indeed

Normal window, debug port closed. Issue #1 stays open for the driven browser.

| From | Option | To | Result |
|---|---|---|---|
| `https://pk.indeed.com/` | Button `full details of {title}`. The company is the link `{Company} (opens in a new tab)`. The city is the text next to that link. A `from=` tracking parameter is not part of this page. | same page, URL gains `vjk=`, and the pane has a link named `Apply now` | reached |
| that homepage | Button `Find jobs` after the title and city are filled | `https://pk.indeed.com/jobs?q={query}&l={city}` | reached |
| that results page | Button `full details of {title}`. The sort link `date` can open a dialog "Be the first to see new {query} jobs". Close it. Do not press Activate. | same page, URL gains `vjk=`, and the pane has a link named `Apply now` | reached |
| that pane | link `Apply now` | `contact-info-module`, or `review-module` when contact, location, and the uploaded CV are already stored | reached |
| address bar `viewjob?jk=` | — | Additional Verification Required | stop. Leave the page. Do not click the check. |
| contact-info-module, "Add your contact information" | Continue. The profile fields were already filled | `.../profile-location` | reached |
| profile-location, "Add or update your address" | Combo "Select a country" to the profile country (the default was United States). City combo "City, province/territory". Leave postcode and street blank. Continue | `.../ooc-question` | reached |
| ooc-question | Yes when already authorized in the job country. Continue | `.../resume-selection-module/resume-selection` | reached |
| resume-selection | The uploaded profile CV, not "Use your Indeed Resume". Continue | `.../review-module` | reached |
| review-module, 100% | Submit your application. Invoke the button, including when it is still below the window. A click can land on the CV preview. Do not scroll inside that preview | `.../post-apply` | reached |
| post-apply | The page says "Your application has been submitted" | — | success |

Stops: "Additional Verification Required" when the debug port is open. A captcha challenge. The reCAPTCHA notice under the form is not that challenge. The review page is not success.

## Discovery navigation (worker scout lane)

Indeed walls cold scripted navigation. The scout's discovery step must NOT `page.goto()` the
`/jobs?q=...` results URL (nor any `viewjob?jk=`). It reaches results the same way a human does:
load `https://pk.indeed.com/`, fill the on-page search (`#text-input-what`, `#text-input-where` =
`Pakistan`), click **Find jobs**. One persistent results tab is kept and re-read across cycles so
re-navigation is rare.

Cadence + backoff (see `src/mcp/indeed-easyapply.js`):
- Normal discovery runs at most once every ~12 minutes (module-level min-interval gate).
- On a Cloudflare wall it hard-backs-off: 20 → 40 → 60 min (cap 60), resetting to 0 after a clean
  cycle. While cooling it returns immediately (`status:'cooling'`) and the scout logs
  `[indeed] cooling … — skipping` WITHOUT navigating.
- The first wall per cooldown period is recorded as an evolution encounter.
- When the cooldown has hit the 60-min cap at least twice (persistent wall), the worker flags the
  user via the dashboard login banner to open Indeed and clear the check manually. Never solve it.
