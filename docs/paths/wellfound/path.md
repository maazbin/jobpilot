# Wellfound

Wellfound is the startup jobs site. The name on the signed-in jobs page is Wellfound.

```tree
follow: reached success

node jobs
  see: wellfound.com/jobs with Home, Profile, Jobs, Applied, and Messages
  branch reached | Profile | profile
  branch reached | a company name | company
  branch reached | a job card | role
  branch stop | the search hides roles that do not accept one city, and the cards are part-time or tutors | jobs

node profile
  see: wellfound.com/profile/edit
  branch reached | Save on the about form after GitHub, the portfolio, the bio, and years | profile
  branch reached | a skill suggestion that starts with the skill name | profile

node company
  see: wellfound.com/company/{slug}
  branch reached | the company website | site
  branch reached | a job on that company | role

node role
  see: wellfound.com/jobs/{id}
  branch reached | the company website names a person and an address | site
  branch stop | the role is part-time, a tutor, or remote in a country list | role

node site
  see: the company website
  branch success | Gmail shows the message sent with the CV | site
  branch stop | the page has no published address | site
```
