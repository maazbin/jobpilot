# Y Combinator

The signed-in jobs page is `ycombinator.com/jobs`. The account control is a button, and Open messages is in the header. A footer link that says Sign In opens the Work at a Startup application. That link is not the account control. Job cards are on this page. Remote Software Engineer Jobs is the next list. When those cards are country lists, the companies directory is next if it already shows My profile.

```tree
follow: reached success

node jobs
  see: ycombinator.com/jobs
  branch reached | the account button, then Remote Software Engineer Jobs | remote_eng
  branch reached | a company job card | company_job
  branch reached | the account control itself says Sign in | login

node remote_eng
  see: ycombinator.com/jobs/role/software-engineer/remote
  branch reached | a company job card | company_job
  branch reached | My profile is already on the companies directory | directory
  branch stop | every card is a country list or an office outside a listed place | remote_eng

node login
  see: account.ycombinator.com/authenticate
  branch reached | My profile on workatastartup.com | directory
  branch stop | the login form is still on screen | login

node directory
  see: workatastartup.com/companies
  branch reached | Show founder details, then View job | job
  branch reached | Remote only, then a role search, then View job | job
  branch stop | US citizenship only, or an office outside a listed place with no visa there | directory

node job
  see: workatastartup.com/jobs/{id}
  branch reached | the YC company page names a founder and publishes an address | founder
  branch stop | the page says the work is in person in the United States | job
  branch stop | Remote is a country list, or the office is outside a listed place and there is no visa there | job

node company_job
  see: ycombinator.com/companies/{slug}/jobs/{id}
  branch reached | the YC company page publishes a founder address | founder
  branch reached | Apply, which asks for the Work at a Startup session | login

node founder
  see: the YC company page with a published founder address
  branch success | Gmail shows the message sent with the CV | founder
  branch retry | the compose window is still open | founder
  branch stop | the page has no published address | founder
```
