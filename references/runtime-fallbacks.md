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
- newer runtime builds use light preflight on `task-prepare` / `task-finalize` to avoid redundant full Playwright attaches at every stage boundary; if a real Playwright attach still fails, expect a runtime incident breaker file at `$BACKLINKHELPER_STATE_DIR/runtime/runtime-incident.json`
- every auto-recovery attempt also updates `$BACKLINKHELPER_STATE_DIR/runtime/runtime-recovery-status.json`; use it to see whether recovery ran, what blocked it, and how many stale regular page targets were closed
- `guarded-drain-status` exposes these signals under `runtime_observability` so operators can see breaker state, browser pollution, and the latest recovery attempt without opening raw runtime files
- practical readout: inspect `runtime_observability.circuit_breaker_open`, `runtime_observability.browser_target_health`, `runtime_observability.last_recovery_attempt`, and `runtime_observability.recent_recovery_attempts` before deciding whether to resume or recycle the shared browser
- when the runtime incident breaker is open, `claim-next-task` first attempts auto-recovery instead of blindly feeding more READY tasks into the active lane; if stale regular page targets are safely closable and a full Playwright recovery probe passes, the breaker clears automatically and claim may continue in the same tick
- if auto-recovery cannot run (active worker lease / browser ownership / pending-finalize) or recovery probe still fails, keep the lane idle and restore / recycle the shared browser first

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

If the helper lives under `$BACKLINKHELPER_STATE_DIR/runtime/`, the relative import to `dist/` is `../../../dist/...`, not `../../dist/...`.

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
- practical follow-up: for manual / hand-built operator envelopes, a populated `account.credential_payload` can still make `task-finalize` hard-fail on missing `BACKLINER_VAULT_KEY` even if the password has already been masked/redacted for logging. When you only need authoritative task-state persistence, strip `credential_payload` entirely before `task-record-agent-trace` / `task-finalize` and keep only non-secret account metadata.
- in cron / operator-only environments where `task-finalize` would otherwise fail on vault writes, it is still valid to persist `account` metadata (email alias, auth mode, login URL, submit URL, registration result) while omitting `credential_payload`; finalize can still upsert the account record without storing secrets
- when the conclusion is mostly visual, do not skip `visual_verification`
- on reachable pages, `task-finalize` may still require `visual_verification` even for non-captcha outcomes such as `WAITING_MISSING_INPUT` or `SKIPPED` if the closure depends on what the screenshot visibly shows (for example: a required full-name field still empty, or a public profile showing only plain text instead of a clickable backlink). If the screenshot materially supports the classification, include `visual_verification` up front rather than assuming it is only for captcha/maintenance cases
- if the authoritative screenshot is extremely tall or otherwise too large for the vision tool/API, keep the original full-page screenshot as repo evidence but generate one or more focused, compressed derivatives (for example a top-of-page crop or resized JPEG via `ffmpeg`/ImageMagick) for visual classification. Record in the operator artifact which derivative was used, so visual verification stays bounded and reproducible instead of failing on payload size alone
- when `browser-use` or repo wrappers complain about missing SOCKS support even on a local CDP session, bypass ad-hoc CLI retries and prefer Playwright / repo-native helpers for the bounded probe, or explicitly clear inherited proxy env vars before invoking the raw CLI; otherwise a local 127.0.0.1 flow can fail for proxy reasons unrelated to the target site
- do not over-trust `guarded-drain-status` / runtime preflight if it says `browser_use_cli=true`: the current preflight only proves that a browser-use binary is resolvable on PATH (or via the repo fallback path), not that its Python environment can actually execute local CDP commands. A host with `ALL_PROXY`/`all_proxy` pointing at a SOCKS proxy but no `socksio` installed can still pass preflight and then fail on the first real browser-use command.
- if raw `browser-use` still throws the same SOCKS/`socksio` error after one bounded retry with proxy env vars cleared, do one more bounded check before giving up on the CLI entirely: read the shared Chrome `webSocketDebuggerUrl` from `/json/version`, close any stale same-name browser-use session, then retry the raw CLI against that websocket CDP URL while keeping proxy env vars cleared. In this runtime, that path has succeeded even when the plain `http://127.0.0.1:9224` form kept failing with the SOCKS error. If the websocket retry also fails, then stop experimenting and switch immediately to a shared-CDP Playwright/manual probe, collect authoritative DOM evidence there, and finish the run through `task-record-agent-trace` + `task-finalize`.
- the same proxy caveat applies when importing the repo’s compiled Node helpers (`dist/execution/browser-use-cli.js`) inside a one-off Node script: those helpers inherit the parent `node` process environment, so launch the parent process itself with `env -u all_proxy -u ALL_PROXY -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY node ...` if proxy variables are set. Practical follow-up: if the helper still fails while pointed at `http://127.0.0.1:9224`, retry the helper itself against the shared browser websocket URL from `/json/version`; the compiled helper path has also been observed to recover once both conditions are true: proxy env cleared on the parent `node` process, and `cdpUrl` switched from the HTTP base to the websocket debugger URL.
- when a claimed surface looks superficially actionable because a visible comment box exists, do not assume it is an acceptable backlink slot. If fresh browser-use + Playwright evidence shows the live page is just a public listing/article with a generic comment form and no visible website/URL field, no profile/settings link slot, and no family-appropriate auth continuation that would create a truthful backlink field, do not force the promoted URL into the comment body just to manufacture a win. Record the comment-only surface explicitly and close it as `SKIPPED + unsupported_surface_no_direct_backlink_slot`.
- when the site is a suspected blank shell/stale surface, include concrete DOM evidence such as empty `document.body.innerText`, empty form/control counts, tiny HTML length, and matching dark/blank screenshots
- if a cookie/privacy overlay obscures the screenshot and the vision pass therefore only describes a generic landing/process page, do not let the weak visual read erase stronger same-tick DOM/body evidence. For paid-policy closures in particular, keep the screenshot as artifact proof of the visible surface, but ground `visual_verification.summary` and `proposed_outcome` on the combined evidence chain: current URL, visible CTA/step cards, DOM/body text (for example explicit `one-time $10 fee` copy), and the absence of visible form fields. Record explicitly that vision under-saw the fee text because of the overlay, so finalize still receives a stable paid-boundary explanation instead of a vague `marketing_or_homepage` guess.
- `task-finalize` may still run shared link verification after accepting your proposed blocker outcome, and the finalization artifact's `current_url` / `link_verification.live_page_url` can end up on an unrelated outbound/profile target (for example a Telegram/contact page or some other previously-open account/profile tab) rather than the auth/policy page you probed. This is not limited to non-directory families: it has also been observed on directory auth/email-verification closures where the authoritative task status was correctly written as `WAITING_EXTERNAL_EVENT + EMAIL_VERIFICATION_PENDING`, but `link_verification.live_page_url` still pointed at an unrelated hostname from another tab. The same pattern can happen on stale/holding/shutdown-page reprobes: even when your fresh shared-CDP evidence proves the canonicalized target is now a dead Glitch/hosting placeholder with no actionable surface, finalize may still persist a foreign `live_page_url`. Do not let that overwrite the primary blocker classification when your fresh evidence already proves a policy/auth/stale-surface boundary; verify the persisted repo `status` + `wait_reason_code`, and treat the verifier URL only as supplemental backlink-check context or an explicit verifier-contamination runtime anomaly.
- A stronger cross-host form of the same bug can surface as `FINALIZATION_PAGE_CONTEXT_MISMATCH`: finalize may inspect an entirely different retained tab/host (for example a foreign public page left open in shared Chrome) and refuse to persist your otherwise-correct blocker outcome. When this happens, do one bounded re-anchor instead of accepting the mismatch as site truth: inspect the current target graph (`/json/list` or equivalent), ensure a retained page is actually on the authoritative task host/URL, and if needed open or retarget one page to the exact handoff URL before retrying. Then rerun `task-record-agent-trace` + `task-finalize` once. If the second finalize lands on the intended host and the repo state matches your blocker outcome, treat the first mismatch as a shared-CDP page-selection anomaly rather than a real retryable site failure.
- Practical variant: the mismatched host may be `chrome://omnibox-popup.top-chrome` rather than a normal foreign site tab. In that state, even closing visible omnibox popup targets, activating the retained task page, or opening a fresh task-host tab may still leave finalize bound to the omnibox popup on the retry. If one bounded re-anchor + re-record + retry still lands on `omnibox-popup.top-chrome`, stop within the same worker tick: keep the fresh task-host operator evidence as the real site conclusion, report the authoritative repo state separately as a runtime page-selection bug, and do not burn more retries trying to win the same finalize race.
- Another practical variant is `chromewebdata`: finalize can attach to a browser-generated error/placeholder tab even when your fresh operator evidence already proved a live same-host outcome. In that state, a bounded re-anchor can still succeed if you explicitly seed a retained page on the exact handoff URL first (for example via CDP `/json/new` with the authoritative task URL), then rerun `task-record-agent-trace` + `task-finalize` once. Treat the first `chromewebdata` finalize result as a shared-CDP page-selection anomaly, not as authoritative evidence about the target site.
- A same-host variant can also suppress an otherwise valid manual `visual_verification`: if shared Chrome still has several retained tabs on the same hostname, `task-finalize` may bind to a different reachable same-host page than the one your handoff summarized. In that state, finalize can emit `VISUAL_VERIFICATION_REQUIRED` / `no visual verification payload was provided` even though the freshly recorded trace already contains a visual payload, simply because the finalizer inspected the wrong retained page and reclassified the surface as ambiguous. When this happens, do one bounded cleanup/re-anchor before retrying finalize: navigate an already-retained page (or otherwise ensure the preferred retained page) to the authoritative URL you want finalized, then rerun `task-record-agent-trace` + `task-finalize`. Treat the first misleading finalize result as a runtime page-selection anomaly, not proof that your handoff lacked visual evidence.
- Practical follow-up for the same-host/cross-host mismatch family: a failed `task-finalize` may already have closed the browser-use session referenced by your original handoff. If you need one bounded retry after `VISUAL_VERIFICATION_REQUIRED` or `FINALIZATION_PAGE_CONTEXT_MISMATCH`, do not just rerun finalize against the stale handoff/session id. First create or reuse a fresh task-scoped browser-use/shared-CDP page on the authoritative host URL, confirm it is the page now showing the blocker text, then update the handoff (`browser_use_session` and, if needed, `current_url`) before re-running `task-record-agent-trace` + `task-finalize`. Otherwise finalize can keep drifting to an unrelated retained tab and make the retry look like another site failure instead of a page-selection bug.
- The same verifier-contamination caveat also applies to `wp_comment` anti-spam / duplicate-comment closures reached via manual Playwright fallback. Even when fresh evidence shows a canonical WordPress `wp-comments-post.php` rejection such as `Duplicate comment detected; it looks as though you've already said that!`, `task-finalize` may still persist a foreign `current_url` / `link_verification.live_page_url` from another open public tab. In that case, keep the primary closure on the anti-spam blocker (`WAITING_POLICY_DECISION` / `COMMENT_ANTI_SPAM_BLOCKED`) and explicitly call out the verifier URL as a runtime anomaly instead of treating it as the authoritative page you just probed.
- Additional `wp_comment` persistence caveat: after a manual Playwright fallback successfully posts a live public comment and `task-finalize` lands on `DONE + verified_link_present`, the persisted `wp_comment_state` payload can still inherit stale continuation metadata from finalize (for example `detail: No visible wp_comment editor was available after authentication` plus a generated fallback `comment_body` that was never the real live comment). Treat `status`, `last_takeover_outcome`, and `link_verification` as the authoritative business outcome, and use your own operator probe/live-page artifacts to report the actual posted comment text if `wp_comment_state` clearly contradicts the live evidence.
- when `task-prepare` stops at a navigation error that may mask a dead surface (for example TLS/SNI failure, HTTP error page, or a blocked deep thread URL), do one bounded manual probe before accepting the generic retry bucket: check protocol variants when safe (`https` vs `http`), probe the site root/homepage, and capture authoritative shared-CDP screenshots. If the deep URL is now a 404/stale page and the root is only a default hosting/parking page, reclassify to a terminal unsupported-surface skip instead of leaving it `RETRYABLE`.
- for upstream-outage retry cases, prefer one authoritative reprobe that records both browser evidence and transport evidence together: capture shared-CDP screenshots/text for the target URL and site root, then also record `curl -I -L` (or equivalent) for the same HTTP/HTTPS variants. This helps distinguish a real host outage (`502`, empty upstream reply, or HTTPS handshake failure) from a polluted browser tab, and gives `task-finalize` a stronger basis for keeping the task in `RETRYABLE` / `DIRECTORY_UPSTREAM_5XX` instead of a vaguer navigation-failure bucket.
- for Microsoft/Dynamics-style portal forums, a blocked deep forum URL does not necessarily mean the whole surface is down. Do one bounded public-path probe of the sign-in/register tabs (for example `/Account/Login/Register?returnUrl=%2F`) before settling. If the public register flow is reachable and the remaining blocker is a visible CAPTCHA/Telerik challenge after truthful fields are filled, finalize as `captcha_blocked` rather than a generic navigation retry.
- if a public registration form accepts truthful fields but then returns a site-side reCAPTCHA/configuration failure such as `reCAPTCHA ERROR: The secret parameter is missing or invalid` while no visible CAPTCHA widget is present, do **not** collapse it into `WAITING_MANUAL_AUTH` or ordinary `captcha_blocked`. Treat it as a retryable site/runtime failure on the target surface, keep screenshots plus DOM/error-banner evidence, and persist a system-owned auto-resume wait reason that makes the misconfigured registration layer explicit.
- if a directory submit form is fully truthful and passes native validity, but the official POST returns a first-party server exception page instead of any success/pending-review state (for example ASP.NET/SMTP failures such as `Failure sending mail` or `net_io_connectionclosed`), classify it as a retryable site/upstream failure rather than a successful submission or missing-input blocker. Keep the proof bundle together: pre-submit validity evidence, the post-submit screenshot, the POST status code, and the server-error text/stack trace. Default closure should be `RETRYABLE` with a system-owned auto-resume wait such as `DIRECTORY_UPSTREAM_5XX` when that best matches repo semantics.
- if a public directory submit form shows only ordinary visible fields, but the real submit control stays disabled because inline/front-end logic depends on a missing DOM field that is not actually rendered (for example `document.submitForm.code`) and a bounded same-form submission probe returns a first-party `405 Method Not Allowed` or comparable method/route failure, treat it as a broken site-side submit surface rather than `WAITING_MISSING_INPUT` or manual-auth. Record the visible form fields, the disabled control state, the exact inline JS dependency mismatch, and the authoritative POST result together. Default closure should stay retryable with a system-owned auto-resume wait (for example `DIRECTORY_NAVIGATION_FAILED`) until the site fixes its own public submit path.
- if signup succeeds and verification mail arrives, but the site's activation/reset continuation route renders a blank SPA shell or console-side frontend exception (for example Angular `NG0201`) instead of the expected form, do one bounded same-site reverse-engineering pass before giving up. Confirm the account email/activation evidence, inspect the public JS/API surface for the exact continuation endpoints already used by the site (for example same-site `new_password_post` / `login` after a broken reset-token route), and only continue with those first-party endpoints plus the existing session state. Record the console error, the blank-page screenshot/DOM metrics, the API endpoints used, and the recovered logged-in destination in the operator evidence. If this still leaves required truthful fields missing on the post-login submit form, finalize as `WAITING_MISSING_INPUT` rather than misclassifying it as manual auth or generic runtime failure.

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
- if the live browser automation surface goes blank, resets to `about:blank`, or otherwise loses the target page during evidence collection, do not give up on CAPTCHA classification if you already have a repo-native scout/focused screenshot plus DOM/form evidence from the same tick. Reuse the saved artifact screenshot with `vision_analyze` (or equivalent image review) and pair it with authoritative DOM inspection to produce `visual_verification`, then finalize from those persisted artifacts instead of insisting on one more fragile live screenshot.
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
- when the page contains multiple forms (for example a site-wide search box plus a signup/comment form), do **not** run validity against `document.querySelector('form')` or all document inputs indiscriminately; first scope to the family-appropriate candidate form that contains the submit-surface fields you just filled, otherwise a global nav/search form can create false `WAITING_MISSING_INPUT` evidence
- after scoping to the correct form, record both `form.checkValidity()` and the remaining invalid controls on that same form so you can truthfully say whether the only blocker left is CAPTCHA / human verification
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
