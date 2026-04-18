# Runtime Fallbacks

This file is part of `web-backlinker-v3-operator`.

It absorbs the former sibling skills:
- `backlinkhelper-manual-operator-envelope`
- `backlinkhelper-operator-manual-probe-finalize`
- `backlinkhelper-maintenance-page-reverify-finalize`
- `backlinkhelper-captcha-evidence-finalize`
- `backlinkhelper-native-validity-probe`

These are not independent entry skills anymore. They are runtime fallback branches under the same V3 operator contract.

## Shared invariants

All fallback branches below still obey the same bounded-task rules:
- exactly one claimed task only
- `task-prepare` ran first
- task-scoped browser-use session only; never reuse implicit `default`
- evidence must become repo-native artifacts, not chat-only observations
- always run `task-record-agent-trace`
- always run `task-finalize`
- verify final task state from repo state, not from vague page impressions

When assembling an envelope manually:
- `handoff.agent_trace_ref` must point to the canonical future trace artifact path (`<artifacts>/<taskId>-agent-loop.json`), not to the temporary runtime envelope file
- if the conclusion depends on screenshots/visual state, include `visual_verification`
- if package-script wrappers are broken but `dist/cli/index.js` exists, fall back to `corepack pnpm exec node dist/cli/index.js <subcommand> ...`
- interpret `task-finalize` by shell exit code plus persisted task state; JSON `ok: false` can still mean a valid finalized non-success outcome
- if `preflight` shows `cdp_runtime.ok=true` but `playwright.ok=false` after the websocket connects, suspect target-graph pollution on the dedicated 9224 Chrome before assuming the browser is dead; when no browser ownership lock, worker lease, or pending-finalize is active, closing stale CDP `page` targets can restore Playwright without restarting the profile

Prefer the repo’s compiled helpers over ad-hoc shell scraping:
- `dist/execution/browser-use-cli.js`
- `dist/memory/data-store.js`

Useful helper calls:
- `openBrowserUseUrl(...)`
- `settleBrowserUsePage(...)`
- `getBrowserUseSnapshot(...)`
- `saveBrowserUseScreenshot(...)`
- `evaluateBrowserUse(...)`
- Playwright confirmation on shared CDP when the conclusion needs authoritative visual/DOM corroboration

## Fallback 1: manual probe / envelope / operator-only finalize

Use this fallback when:
- a task is claimed
- `task-prepare` returns `ready_for_agent_loop`
- the repo cannot or should not run the normal agent loop automatically
- you still need one bounded operator tick with fresh evidence and a valid finalize chain

Typical cases:
- no repo-native subcommand exists for the needed operator path
- runtime is in operator-only mode
- you need to probe the deepest same-flow surface manually

### Recommended pattern

1. Claim and prepare:

```bash
corepack pnpm claim-next-task -- --owner <owner> --task-id-prefix <prefix>
corepack pnpm task-prepare -- --task-id <task_id> --cdp-url http://127.0.0.1:9224
```

2. If prepare already stops/replays/settles the task, stop here. Do not force a manual loop.

3. If prepare returns `ready_for_agent_loop`, create a short one-off Node helper under either:
- repo runtime data, or
- repo root as a temporary helper

If the helper lives under `data/backlink-helper/runtime/`, the relative import to `dist/` is `../../../dist/...`, not `../../dist/...`.

4. In the helper:
- generate a short task-scoped session name; prefer a readable short task fragment + timestamp over the full long task id
- open the prepared URL on shared CDP
- capture URL/title/state/body/viewport/screenshot evidence
- use `evaluateBrowserUse()` early to confirm viewport sanity before trusting blank/ambiguous state
- if browser-use looks stale, blank, or dubious, also capture authoritative Playwright evidence on a fresh CDP page
- write runtime artifacts such as:
  - `operator-probe-<timestamp>.json`
  - `operator-evidence-<timestamp>.json`
  - `operator-envelope-<timestamp>.json`

5. Build a valid `AgentTraceEnvelope` with:
- `trace`
- `handoff`
- optional `account`
- `handoff.browser_use_session`
- `handoff.current_url`
- `handoff.recorded_steps`
- `handoff.agent_backend`
- `handoff.agent_steps_count`
- `handoff.proposed_outcome`
- `handoff.visual_verification` when the conclusion is visual

6. Persist:

```bash
corepack pnpm task-record-agent-trace -- --task-id <task_id> --payload-file <envelope.json>
corepack pnpm task-finalize -- --task-id <task_id> --cdp-url http://127.0.0.1:9224
```

7. Verify:
- task JSON updated
- pending-finalize cleared
- final status/wait reason match the intended bounded outcome

### Manual-probe pitfalls

- do not assume plain `browser-use` is on PATH; repo preflight may resolve a fallback binary path
- if the environment lacks `BACKLINER_VAULT_KEY`, do not include `account.credential_payload` unless credential persistence is truly required
- in cron / operator-only environments where `task-finalize` would otherwise fail on vault writes, it is still valid to persist `account` metadata (email alias, auth mode, login URL, submit URL, registration result) while omitting `credential_payload`; finalize can still upsert the account record without storing secrets
- when the conclusion is mostly visual, do not skip `visual_verification`
- on reachable pages, `task-finalize` may still require `visual_verification` even for non-captcha outcomes such as `WAITING_MISSING_INPUT` or `SKIPPED` if the closure depends on what the screenshot visibly shows (for example: a required full-name field still empty, or a public profile showing only plain text instead of a clickable backlink). If the screenshot materially supports the classification, include `visual_verification` up front rather than assuming it is only for captcha/maintenance cases
- when `browser-use` or repo wrappers complain about missing SOCKS support even on a local CDP session, bypass ad-hoc CLI retries and prefer Playwright / repo-native helpers for the bounded probe, or explicitly clear inherited proxy env vars before invoking the raw CLI; otherwise a local 127.0.0.1 flow can fail for proxy reasons unrelated to the target site
- the same proxy caveat applies when importing the repo’s compiled Node helpers (`dist/execution/browser-use-cli.js`) inside a one-off Node script: those helpers inherit the parent `node` process environment, so launch the parent process itself with `env -u all_proxy -u ALL_PROXY -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY node ...` if proxy variables are set
- when the site is a suspected blank shell/stale surface, include concrete DOM evidence such as empty `document.body.innerText`, empty form/control counts, tiny HTML length, and matching dark/blank screenshots
- when `task-prepare` stops at a navigation error that may mask a dead surface (for example TLS/SNI failure, HTTP error page, or a blocked deep thread URL), do one bounded manual probe before accepting the generic retry bucket: check protocol variants when safe (`https` vs `http`), probe the site root/homepage, and capture authoritative shared-CDP screenshots. If the deep URL is now a 404/stale page and the root is only a default hosting/parking page, reclassify to a terminal unsupported-surface skip instead of leaving it `RETRYABLE`.
- for upstream-outage retry cases, prefer one authoritative reprobe that records both browser evidence and transport evidence together: capture shared-CDP screenshots/text for the target URL and site root, then also record `curl -I -L` (or equivalent) for the same HTTP/HTTPS variants. This helps distinguish a real host outage (`502`, empty upstream reply, or HTTPS handshake failure) from a polluted browser tab, and gives `task-finalize` a stronger basis for keeping the task in `RETRYABLE` / `DIRECTORY_UPSTREAM_5XX` instead of a vaguer navigation-failure bucket.
- for Microsoft/Dynamics-style portal forums, a blocked deep forum URL does not necessarily mean the whole surface is down. Do one bounded public-path probe of the sign-in/register tabs (for example `/Account/Login/Register?returnUrl=%2F`) before settling. If the public register flow is reachable and the remaining blocker is a visible CAPTCHA/Telerik challenge after truthful fields are filled, finalize as `captcha_blocked` rather than a generic navigation retry.

## Fallback 2: maintenance page / stale holding page reverify

Use this when:
- `task-prepare` returns `ready_for_agent_loop`
- the target submit URL serves a maintenance page, holding page, stale surface, or temporary outage
- prior runs may have lacked visual verification
- you still need authoritative closure inside repo state

Common signals:
- title like `Maintenance in Progress`
- copy like `We're Under Maintenance` or `back online shortly`
- reachable 200 page but no actionable submit surface

### Recommended pattern

1. Use a short task-scoped browser-use session.
2. Capture fresh browser-use evidence:
- current URL
- title
- viewport
- raw text excerpt
- screenshot

3. Capture authoritative Playwright evidence on the same URL:
- current URL
- title
- body excerpt
- screenshot

4. Write an observation artifact summarizing both sources.
5. Build a manual envelope with `visual_verification`.
6. Choose `proposed_outcome` carefully:
- if the task already exhausted automatic retries, preserve that semantics rather than blindly downgrading back to ordinary retry
- exhausted-retry maintenance cases often stabilize as:
  - `status = WAITING_RETRY_DECISION`
  - `wait_reason_code = AUTOMATIC_RETRY_EXHAUSTED`

### Maintenance-page pitfalls

- do not skip trace/finalize just because the page is obviously down
- do not rely only on stale scout evidence
- do not infer site failure from a polluted tab without checking current URL/title/viewport in a fresh session

## Fallback 3: CAPTCHA / managed human verification evidence

Use this when:
- `task-prepare` returns `ready_for_agent_loop`
- the page is reachable, but evidence is insufficient and you suspect CAPTCHA / human verification
- you need repo-native proof, not a chat-only opinion

### Recommended pattern

1. Gather fresh evidence with the repo wrapper, not ad-hoc CLI calls.
2. Verify evidence quality first:
- current URL is correct
- viewport is healthy
- snapshot matches the visible surface
- screenshot exists
- if scout already captured a focused iframe/widget screenshot, reuse it

3. Run visual analysis on:
- the fresh full-page screenshot
- any focused iframe/widget screenshot

Goal: distinguish `captcha_or_human_verification` from an ordinary register gate.

4. If the first screenshot does not make the CAPTCHA visually obvious but DOM/state shows clues such as `Complete Captcha` or a reCAPTCHA iframe, do one bounded focused capture that shows the widget near the submit button.

5. Build the envelope with explicit `visual_verification`.

Example target outcome:
- task status `SKIPPED`
- `terminal_class = captcha_blocked`
- `skip_reason_code = captcha_or_human_verification_required`
- `visual_gate_used = true`

### CAPTCHA pitfalls

- do not rely only on page text when iframe evidence exists
- do not stop at chat evidence; persist it through trace/finalize
- if prepare/finalize stop for runtime-health reasons, treat that as runtime failure, not CAPTCHA classification

## Fallback 4: native validity probe for truthful missing-input blockers

Use this when:
- the current surface is clearly a real submit form
- some safe dossier-backed fields can be filled truthfully
- one or more required fields may still be missing
- inventing values would create dirty state

Do not use this to bypass:
- CAPTCHA / managed human verification
- paid listing decisions
- hidden-field hacks
- 2FA / passkey / phone confirmation

### Recommended pattern

1. Confirm the form is real:
- collect URL/title/state/screenshot/visible labels
- verify there is a real submit form, not a login gate, pricing page, or generic utility surface

2. Fill only safe truthful fields from the dossier, such as:
- tool/product name
- descriptions
- company/organization
- website URL
- documentation / GitHub if truly available
- pricing type if known
- clearly-supported platform/category selections

Do not invent:
- human full name
- phone number
- head-office city / contact person
- unverified social URLs
- unverified category values

3. Resolve screenshot-upload requirements authoritatively when needed:
- prefer a real product screenshot if available
- if the site rejects square/logo-like images, capture a fresh wide landscape screenshot and re-upload until the surface clearly accepts it

4. Use native validity instead of guessing.
Example probe:

```js
(() => {
  const form = document.querySelector('form');
  const fields = [...document.querySelectorAll('input, textarea, select')].map((el, i) => ({
    i,
    tag: el.tagName,
    type: el.getAttribute('type'),
    name: el.getAttribute('name'),
    placeholder: el.getAttribute('placeholder'),
    required: el.required,
    value: el.type === 'checkbox' ? String(el.checked) : el.value,
    valid: el.checkValidity(),
    message: el.validationMessage,
  }));
  return {
    formExists: !!form,
    formValid: form ? form.checkValidity() : null,
    invalid: fields.filter((f) => !f.valid),
  };
})()
```

5. If only a few truthful fields remain invalid, classify precisely:
- `proposed_outcome.next_status = WAITING_MISSING_INPUT`
- `wait_reason_code = REQUIRED_INPUT_MISSING`
- `wait.missing_fields = [...]`
- explain why each field is missing and why it cannot be auto-resolved truthfully

6. Preserve authoritative evidence:
- submit-form screenshot
- screenshot-upload acceptance evidence if relevant
- operator evidence JSON summarizing safe fields filled and invalid fields remaining
- trace + finalize

### Native-validity pitfalls

- submit-click failure alone is not an authoritative blocker; native validity may immediately reveal the real missing field
- do not classify `WAITING_MISSING_INPUT` before resolving an image-format blocker when the site clearly wants a wide screenshot
- auth success is not submission readiness
- do not invent human identity fields just to push the form through

## Verification checklist

Before treating any fallback run as complete, verify:
- exactly one task was claimed
- fresh evidence was generated this tick
- task-scoped session naming was used
- `task-record-agent-trace` ran
- `task-finalize` ran
- final task state was read back from repo state
- the chosen fallback branch produced evidence strong enough for the claimed outcome
