# Code for Philly / Laddr comment surface

Validated facts from a successful `wp_comment` run on:
- Host: `codeforphilly.org`
- Article path example: `/blog/questhacks--community_digital_solutions_day/`
- Platform cue in footer: `Powered by Laddr — a Code for Philly project.`

## Surface facts

- Logged-out article pages render the public comment thread plus a bottom login hint: `Log in to post a comment.`
- A public header `Sign up` link leads to `/register?return=<article>`.
- The registration form is a straightforward public email/password flow with visible fields:
  - first name
  - last name
  - email
  - username
  - password
  - password confirmation
- No CAPTCHA was encountered on the validated run.
- After successful signup, the site returns a `Registration complete` page with a `Continue back to ...` link to the article.
- Once signed in, the article footer exposes a real comment composer with:
  - signed-in identity label
  - `textarea#Message`
  - `Post Comment` button
  - explicit note that `Markdown` is supported

## Backlink behavior verified

- Markdown links in the comment body were rendered as live public anchors on the article page.
- Verified example outcome:
  - public comment visible immediately after submission
  - anchor text: `<promoted site name>`
  - target URL: `<promoted site URL>`
  - rel flags observed: none
- On the validated run, success was immediate live publication, not a moderation-only preview.

## Operator implications

- Do not stop at the logged-out `Log in to post a comment` hint; this host has a real public signup continuation.
- For this Laddr-style surface, comment-body backlink verification matters more than profile-link speculation.
- Because Markdown is explicitly allowed, a bounded markdown link in the comment body is a legitimate candidate format.
- Still verify on the public article page after submit; do not trust only the `Comment saved.` confirmation surface.
