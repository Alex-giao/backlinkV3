import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "./command.js";
import type { CommandResult } from "./command.js";

export type MailCommandRunner = (
  command: string,
  args: string[],
  timeoutMs?: number,
) => Promise<CommandResult>;

export type MailProvider = "gog" | "gws";

export interface MailProviderStatus {
  ok: boolean;
  provider?: MailProvider;
  detail: string;
}

export interface GogSearchMessage {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  snippet?: string;
  body?: string;
}

interface GogMessagePayload {
  id?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
  };
  snippet?: string;
  body?: string;
}

interface GwsSearchPayload {
  messages?: Array<{
    id?: string;
    subject?: string;
    from?: string;
    to?: string;
    date?: string;
    snippet?: string;
  }>;
}

interface GwsGetPayload {
  subject?: string;
  date?: string;
  body_text?: string;
  from?: { name?: string | null; email?: string | null };
  to?: Array<{ name?: string | null; email?: string | null }> | null;
}

function findHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  headerName: string,
): string | undefined {
  return headers?.find((header) => header.name?.toLowerCase() === headerName.toLowerCase())?.value;
}

function getHermesHomePath(override?: string): string {
  return override ?? process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes");
}

function getGoogleWorkspaceApiPath(hermesHome?: string): string {
  return path.join(
    getHermesHomePath(hermesHome),
    "skills",
    "productivity",
    "google-workspace",
    "scripts",
    "google_api.py",
  );
}

function getGoogleWorkspaceSetupPath(hermesHome?: string): string {
  return path.join(
    getHermesHomePath(hermesHome),
    "skills",
    "productivity",
    "google-workspace",
    "scripts",
    "setup.py",
  );
}

function getPreferredPythonBin(hermesHome?: string): string {
  const root = getHermesHomePath(hermesHome);
  const venvPython = path.join(root, "hermes-agent", "venv", "bin", "python");
  return existsSync(venvPython) ? venvPython : process.env.HERMES_PYTHON ?? "python3";
}

function formatMailbox(value: { name?: string | null; email?: string | null } | undefined): string | undefined {
  if (!value?.email) {
    return undefined;
  }
  return value.name ? `${value.name} <${value.email}>` : value.email;
}

export function parseGwsSearchPayload(raw: string): GogSearchMessage[] {
  const parsed = JSON.parse(raw) as GwsSearchPayload;
  return (parsed.messages ?? [])
    .filter((message): message is NonNullable<GwsSearchPayload["messages"]>[number] & { id: string } => Boolean(message?.id))
    .map((message) => ({
      id: message.id,
      ...(message.subject ? { subject: message.subject } : {}),
      ...(message.from ? { from: message.from } : {}),
      ...(message.to ? { to: message.to } : {}),
      ...(message.date ? { date: message.date } : {}),
      ...(message.snippet ? { snippet: message.snippet } : {}),
    }));
}

export function parseGwsGetPayload(raw: string): {
  subject?: string;
  body: string;
  from?: string;
  to?: string;
} {
  const parsed = JSON.parse(raw) as GwsGetPayload;
  return {
    subject: parsed.subject,
    from: formatMailbox(parsed.from),
    to: parsed.to?.map((entry) => formatMailbox(entry)).filter(Boolean).join(", "),
    body: parsed.body_text ?? "",
  };
}

export async function detectMailProvider(args: {
  runner?: MailCommandRunner;
  hermesHome?: string;
  pythonBin?: string;
} = {}): Promise<MailProviderStatus> {
  const runner = args.runner ?? runCommand;
  const gogResult = await runner("which", ["gog"]);
  if (gogResult.exit_code === 0 && gogResult.stdout.trim()) {
    return {
      ok: true,
      provider: "gog",
      detail: `gog detected at ${gogResult.stdout.trim()}.`,
    };
  }

  const gwsResult = await runner("which", ["gws"]);
  const setupPath = getGoogleWorkspaceSetupPath(args.hermesHome);
  if (gwsResult.exit_code !== 0 || !gwsResult.stdout.trim()) {
    return {
      ok: false,
      detail: "Neither gog nor gws mail tooling is available in PATH.",
    };
  }
  if (!existsSync(setupPath)) {
    return {
      ok: false,
      detail: `gws is installed but Google Workspace setup script is missing at ${setupPath}.`,
    };
  }

  const pythonBin = args.pythonBin ?? getPreferredPythonBin(args.hermesHome);
  const checkResult = await runner(pythonBin, [setupPath, "--check"]);
  if (checkResult.exit_code !== 0) {
    return {
      ok: false,
      detail: `gws is installed but Google Workspace auth is not ready: ${checkResult.stderr.trim() || checkResult.stdout.trim() || "setup check failed"}.`,
    };
  }

  return {
    ok: true,
    provider: "gws",
    detail: `gws fallback is available via ${gwsResult.stdout.trim()} with authenticated Google Workspace setup.`,
  };
}

export interface GogMessageCandidate {
  id: string;
  score: number;
  reasons: string[];
  query_sources: string[];
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  date_iso?: string;
  age_minutes?: number;
  snippet?: string;
  body?: string;
  within_window: boolean;
  magic_link?: string;
  verification_code?: string;
}

function buildGogArgs(args: {
  query?: string;
  account?: string;
  max?: number;
  includeBody?: boolean;
  messageId?: string;
}): string[] {
  const commandArgs = args.messageId
    ? [
        "gmail",
        "get",
        args.messageId,
        "--json",
        "--results-only",
        "--format=full",
        "--no-input",
      ]
    : [
        "gmail",
        "messages",
        "search",
        args.query ?? "",
        "--json",
        "--results-only",
        `--max=${args.max ?? 1}`,
        ...(args.includeBody ? ["--include-body"] : []),
        "--no-input",
      ];

  if (args.account) {
    commandArgs.splice(0, 0, `--account=${args.account}`);
  }

  return commandArgs;
}

function ensureUnreadQuery(query: string): string {
  return /\bis:unread\b/i.test(query) ? query : `is:unread ${query}`.trim();
}

function normalizeText(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function normalizeHostnameTokens(hostname: string | undefined): string[] {
  if (!hostname) {
    return [];
  }

  const host = hostname.toLowerCase().replace(/^www\./, "");
  const tokens = new Set<string>();
  for (const part of host.split(/[^a-z0-9]+/)) {
    if (part.length >= 4 && !["com", "org", "net", "app", "io", "ai", "co"].includes(part)) {
      tokens.add(part);
    }
  }
  return [...tokens];
}

function parseDate(rawDate: string | undefined): { iso?: string; ageMinutes?: number; withinWindow: boolean } {
  if (!rawDate) {
    return { withinWindow: false };
  }

  const parsedMs = Date.parse(rawDate);
  if (!Number.isFinite(parsedMs)) {
    return { withinWindow: false };
  }

  const ageMinutes = Math.max(0, Math.round((Date.now() - parsedMs) / 60_000));
  return {
    iso: new Date(parsedMs).toISOString(),
    ageMinutes,
    withinWindow: ageMinutes <= 60,
  };
}

function scoreCandidate(args: {
  message: GogSearchMessage & { query_sources: string[] };
  primaryEmail?: string;
  emailAlias?: string;
  hostname?: string;
  windowHours: number;
}): GogMessageCandidate {
  const combined = [args.message.subject, args.message.snippet, args.message.body, args.message.from, args.message.to]
    .filter(Boolean)
    .join("\n");
  const normalized = normalizeText(combined);
  const reasons: string[] = [];
  let score = 0;

  const alias = args.emailAlias?.toLowerCase();
  const primaryEmail = args.primaryEmail?.toLowerCase();
  const toField = normalizeText(args.message.to);
  const fromField = normalizeText(args.message.from);

  if (alias && toField.includes(alias)) {
    score += 45;
    reasons.push("matched registration alias");
  }

  if (primaryEmail && toField.includes(primaryEmail)) {
    score += 20;
    reasons.push("matched primary submitter email");
  }

  const hostTokens = normalizeHostnameTokens(args.hostname);
  const matchedHostTokens = hostTokens.filter((token) => normalized.includes(token));
  if (matchedHostTokens.length > 0) {
    score += 12 + matchedHostTokens.length * 3;
    reasons.push(`matched hostname token(s): ${matchedHostTokens.join(", ")}`);
  }

  const verificationKeywords = [
    "magic link",
    "sign in link",
    "sign-in link",
    "verify",
    "verification",
    "confirm",
    "login",
    "log in",
    "sign in",
    "authenticate",
    "one-time",
  ].filter((keyword) => normalized.includes(keyword));
  if (verificationKeywords.length > 0) {
    score += 18;
    reasons.push(`verification wording: ${verificationKeywords.slice(0, 3).join(", ")}`);
  }

  if (/noreply|no-reply|auth|support/i.test(args.message.from ?? "")) {
    score += 4;
    reasons.push("sender looks like an automated auth/verification mailbox");
  }

  const magicLink = extractMagicLink(args.message.body ?? args.message.snippet ?? "");
  if (magicLink) {
    score += 12;
    reasons.push("contains a likely verification or magic link");
  }

  const verificationCode = extractVerificationCode(args.message.body ?? args.message.snippet ?? "");
  if (verificationCode) {
    score += 8;
    reasons.push("contains a likely verification code");
  }

  const timing = parseDate(args.message.date);
  if (typeof timing.ageMinutes === "number") {
    if (timing.ageMinutes <= 15) {
      score += 12;
    } else if (timing.ageMinutes <= 30) {
      score += 8;
    } else if (timing.ageMinutes <= args.windowHours * 60) {
      score += 4;
    }
    reasons.push(`age ${timing.ageMinutes} minute(s)`);
  }

  return {
    id: args.message.id,
    score,
    reasons,
    query_sources: args.message.query_sources,
    subject: args.message.subject,
    from: args.message.from,
    to: args.message.to,
    date: args.message.date,
    date_iso: timing.iso,
    age_minutes: timing.ageMinutes,
    snippet: args.message.snippet,
    body: args.message.body,
    within_window: typeof timing.ageMinutes === "number" ? timing.ageMinutes <= args.windowHours * 60 : false,
    magic_link: magicLink,
    verification_code: verificationCode,
  };
}

async function searchEmailsWithProvider(args: {
  provider: MailProvider;
  query: string;
  account?: string;
  max?: number;
  includeBody?: boolean;
  runner?: MailCommandRunner;
  hermesHome?: string;
  pythonBin?: string;
}): Promise<GogSearchMessage[]> {
  const runner = args.runner ?? runCommand;
  if (args.provider === "gog") {
    const result = await runner(
      "gog",
      buildGogArgs({
        query: args.query,
        account: args.account,
        max: args.max,
        includeBody: args.includeBody,
      }),
      30_000,
    );
    if (result.exit_code !== 0 || !result.stdout.trim()) {
      return [];
    }

    const parsed = JSON.parse(result.stdout) as GogSearchMessage[] | GogSearchMessage;
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  const pythonBin = args.pythonBin ?? getPreferredPythonBin(args.hermesHome);
  const googleApiPath = getGoogleWorkspaceApiPath(args.hermesHome);
  const result = await runner(
    pythonBin,
    [googleApiPath, "gmail", "search", args.query, "--max", String(args.max ?? 1)],
    30_000,
  );
  if (result.exit_code !== 0 || !result.stdout.trim()) {
    return [];
  }

  const messages = parseGwsSearchPayload(result.stdout);
  if (!args.includeBody) {
    return messages;
  }

  const enriched = await Promise.all(
    messages.map(async (message) => {
      const body = await getEmailBodyWithProvider({
        provider: "gws",
        messageId: message.id,
        runner,
        hermesHome: args.hermesHome,
        pythonBin,
      });
      return {
        ...message,
        from: body?.from ?? message.from,
        to: body?.to ?? message.to,
        body: body?.body,
      } satisfies GogSearchMessage;
    }),
  );
  return enriched;
}

export async function searchEmails(args: {
  query: string;
  account?: string;
  max?: number;
  includeBody?: boolean;
  runner?: MailCommandRunner;
  hermesHome?: string;
  pythonBin?: string;
}): Promise<GogSearchMessage[]> {
  const provider = await detectMailProvider({
    runner: args.runner,
    hermesHome: args.hermesHome,
    pythonBin: args.pythonBin,
  });
  if (!provider.ok || !provider.provider) {
    return [];
  }
  return searchEmailsWithProvider({
    ...args,
    provider: provider.provider,
  });
}

export async function searchLatestEmail(args: {
  query: string;
  account?: string;
  runner?: MailCommandRunner;
  hermesHome?: string;
  pythonBin?: string;
}): Promise<GogSearchMessage | undefined> {
  const messages = await searchEmails({
    query: args.query,
    account: args.account,
    max: 1,
    includeBody: true,
    runner: args.runner,
    hermesHome: args.hermesHome,
    pythonBin: args.pythonBin,
  });
  return messages[0];
}

async function getEmailBodyWithProvider(args: {
  provider: MailProvider;
  messageId: string;
  account?: string;
  runner?: MailCommandRunner;
  hermesHome?: string;
  pythonBin?: string;
}): Promise<{ subject?: string; body: string; from?: string; to?: string } | undefined> {
  const runner = args.runner ?? runCommand;
  if (args.provider === "gog") {
    const result = await runner(
      "gog",
      buildGogArgs({
        messageId: args.messageId,
        account: args.account,
      }),
      30_000,
    );
    if (result.exit_code !== 0 || !result.stdout.trim()) {
      return undefined;
    }

    const payload = JSON.parse(result.stdout) as GogMessagePayload;
    return {
      subject: findHeader(payload.payload?.headers, "Subject"),
      from: findHeader(payload.payload?.headers, "From"),
      to: findHeader(payload.payload?.headers, "To"),
      body: payload.body ?? payload.snippet ?? "",
    };
  }

  const pythonBin = args.pythonBin ?? getPreferredPythonBin(args.hermesHome);
  const googleApiPath = getGoogleWorkspaceApiPath(args.hermesHome);
  const result = await runner(
    pythonBin,
    [googleApiPath, "gmail", "get", args.messageId],
    30_000,
  );
  if (result.exit_code !== 0 || !result.stdout.trim()) {
    return undefined;
  }
  return parseGwsGetPayload(result.stdout);
}

export async function getEmailBody(args: {
  messageId: string;
  account?: string;
  runner?: MailCommandRunner;
  hermesHome?: string;
  pythonBin?: string;
}): Promise<{ subject?: string; body: string; from?: string; to?: string } | undefined> {
  const provider = await detectMailProvider({
    runner: args.runner,
    hermesHome: args.hermesHome,
    pythonBin: args.pythonBin,
  });
  if (!provider.ok || !provider.provider) {
    return undefined;
  }
  return getEmailBodyWithProvider({
    ...args,
    provider: provider.provider,
  });
}

export async function triageRecentUnreadEmails(args: {
  mailboxQuery?: string;
  primaryEmail?: string;
  emailAlias?: string;
  hostname?: string;
  account?: string;
  windowHours?: number;
  maxSearch?: number;
  maxCandidates?: number;
}): Promise<{
  query_plans: Array<{ source: string; query: string }>;
  scanned_count: number;
  filtered_window_count: number;
  candidates: GogMessageCandidate[];
}> {
  const windowHours = Math.max(1, args.windowHours ?? 1);
  const maxSearch = Math.max(5, args.maxSearch ?? 20);
  const maxCandidates = Math.max(1, args.maxCandidates ?? 5);

  const queryPlans: Array<{ source: string; query: string }> = [];
  if (args.mailboxQuery?.trim()) {
    queryPlans.push({ source: "mailbox_query", query: ensureUnreadQuery(args.mailboxQuery.trim()) });
  }
  if (args.emailAlias?.trim()) {
    queryPlans.push({ source: "email_alias", query: `is:unread to:${args.emailAlias.trim()} newer_than:2d` });
  }
  if (args.primaryEmail?.trim()) {
    queryPlans.push({ source: "primary_email", query: `is:unread to:${args.primaryEmail.trim()} newer_than:2d` });
  }
  queryPlans.push({ source: "recent_unread", query: "is:unread newer_than:2d" });

  const deduped = new Map<string, GogSearchMessage & { query_sources: string[] }>();
  for (const plan of queryPlans) {
    const messages = await searchEmails({
      query: plan.query,
      account: args.account,
      max: maxSearch,
      includeBody: true,
    });

    for (const message of messages) {
      const existing = deduped.get(message.id);
      if (existing) {
        if (!existing.query_sources.includes(plan.source)) {
          existing.query_sources.push(plan.source);
        }
        existing.body = existing.body ?? message.body;
        existing.snippet = existing.snippet ?? message.snippet;
        existing.subject = existing.subject ?? message.subject;
        existing.from = existing.from ?? message.from;
        existing.to = existing.to ?? message.to;
        existing.date = existing.date ?? message.date;
        continue;
      }

      deduped.set(message.id, {
        ...message,
        query_sources: [plan.source],
      });
    }
  }

  const scored = [...deduped.values()].map((message) =>
    scoreCandidate({
      message,
      primaryEmail: args.primaryEmail,
      emailAlias: args.emailAlias,
      hostname: args.hostname,
      windowHours,
    }),
  );

  const withinWindow = scored.filter((candidate) => candidate.within_window);
  const candidatePool = withinWindow.length > 0 ? withinWindow : scored;
  candidatePool.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return (a.age_minutes ?? Number.MAX_SAFE_INTEGER) - (b.age_minutes ?? Number.MAX_SAFE_INTEGER);
  });

  return {
    query_plans: queryPlans,
    scanned_count: deduped.size,
    filtered_window_count: withinWindow.length,
    candidates: candidatePool.slice(0, maxCandidates),
  };
}

export function extractMagicLink(body: string): string | undefined {
  const matches = body.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  if (matches.length === 0) {
    return undefined;
  }

  const preferred = matches.find((url) => /magic|verify|confirm|auth|signin|sign-in|login|token/i.test(url));
  return preferred ?? matches[0];
}

export function extractVerificationCode(body: string): string | undefined {
  const codeMatch = body.match(/\b(\d{4,8})\b/);
  return codeMatch?.[1];
}
