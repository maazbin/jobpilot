# Y Combinator

Work at a Startup is the job site. The public list at `ycombinator.com/jobs` still shows Sign in. A session that already exists opens the companies directory.

```tree
follow: reached success

node jobs
  see: ycombinator.com/jobs
  branch reached | Sign in or Apply | login
  branch reached | a company job link on the public list | company_job

node login
  see: account.ycombinator.com/authenticate
  branch reached | My profile on workatastartup.com | directory
  branch stop | the login form is still on screen | login

node directory
  see: workatastartup.com/companies
  branch reached | Show founder details, then View job | job
  branch stop | US citizenship only, or an office outside a listed place with no visa there | directory

node job
  see: workatastartup.com/jobs/{id}
  branch reached | the company site names a founder and publishes an address | founder
  branch stop | Remote is a country list, or the office is outside a listed place and there is no visa there | job

node company_job
  see: ycombinator.com/companies/{slug}/jobs/{id}
  branch reached | Apply, which asks for the Work at a Startup session | login
  branch reached | the company website linked from the page | founder

node founder
  see: the company site or a sponsor page with a published founder address
  branch success | Gmail shows the message sent with the CV | founder
  branch retry | the compose window is still open | founder
  branch stop | the page has no published address | founder
```
