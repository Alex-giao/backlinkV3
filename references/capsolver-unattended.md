# CapSolver unattended CAPTCHA continuation

V3 unattended mode may use CapSolver automatically when the runtime sees a supported CAPTCHA on a task-bound page.

## Supported surfaces

- `reCAPTCHA v2`: `ReCaptchaV2TaskProxyLess`, detected from `.g-recaptcha[data-sitekey]` or reCAPTCHA iframe `k` parameter.
- `Cloudflare Turnstile`: `AntiTurnstileTaskProxyLess`, detected from `.cf-turnstile[data-sitekey]` / Turnstile DOM. A visible Turnstile iframe without a sitekey remains evidence, but cannot be solved until a sitekey is available.
- Image CAPTCHA / security-code image: `ImageToTextTask`, detected from visible CAPTCHA-like image plus code input. `ImageToTextTask` returns the result directly from `createTask`; token tasks use `createTask` then `getTaskResult` polling.

## Configuration

Set one of:

- `CAPSOLVER_API_KEY` (preferred)
- `CAPSOLVER_CLIENT_KEY`
- `CAP_SOLVER_API_KEY`

Optional tuning:

- `CAPSOLVER_CREATE_TASK_URL` (default `https://api.capsolver.com/createTask`)
- `CAPSOLVER_GET_TASK_RESULT_URL` (default `https://api.capsolver.com/getTaskResult`)
- `CAPSOLVER_POLL_INTERVAL_MS` (default `1000`)
- `CAPSOLVER_MAX_POLLS` (default `25`)
- `CAPSOLVER_REQUEST_TIMEOUT_MS` (default `20000`)

### Persistent setup on the Hermes gateway host

For the user systemd service, prefer a rootless env file rather than shell dotfiles, because Telegram/Hermes gateway jobs inherit the service environment, not an interactive shell:

```bash
mkdir -p ~/.config/hermes
chmod 700 ~/.config/hermes
printf 'CAPSOLVER_API_KEY=%s\n' 'CAP-...' > ~/.config/hermes/backlinkhelper.env
chmod 600 ~/.config/hermes/backlinkhelper.env
```

Then add this line to `~/.config/systemd/user/hermes-gateway.service` under `[Service]`:

```ini
EnvironmentFile=/home/gc/.config/hermes/backlinkhelper.env
```

Run `systemctl --user daemon-reload` and verify with:

```bash
systemctl --user show hermes-gateway.service -p EnvironmentFiles -p LoadState --no-pager
systemd-run --user --wait --pipe -p EnvironmentFile=/home/gc/.config/hermes/backlinkhelper.env /usr/bin/python3 -c 'import os; k=os.getenv("CAPSOLVER_API_KEY",""); print(k[:8]+"...", len(k))'
```

The currently running gateway process will not receive new environment variables until `systemctl --user restart hermes-gateway.service`; avoid restarting mid-chat unless the user accepts a brief Telegram session interruption.

## Runtime behavior

- `UNATTENDED_POLICY.allow_captcha_bypass` is true: a CAPTCHA is no longer an automatic policy stop when a supported solver path exists.
- `task-finalize` attempts a bounded CapSolver continuation on the current task-bound page before final classification and live-link verification.
- The attempt is persisted as `captcha_solver_attempt` in finalization artifacts.
- If solved, the runtime applies the token/text to the page and clicks a likely submit control once, then re-samples page state and screenshot evidence.
- If no supported descriptor or no API key exists, the artifact records that precise reason; do not invent a solved state.

## Boundaries

- Still no paid listings, payment steps, 2FA/passkey, or custom slider/puzzle solves unless a concrete provider implementation exists for that exact challenge type.
- A token/text solve is not success by itself. Final success still requires the normal V3 evidence chain: live link, accepted/pending confirmation, external-event wait, or a precise terminal blocker.
- If CapSolver returns a solution but the site rejects it (`captcha incorrect`, robot check failure, etc.), record the rejection and close according to observed evidence rather than retrying indefinitely.
