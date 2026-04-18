import { randomBytes } from "node:crypto";

export function buildPlusAlias(baseEmail: string | undefined, hostname: string): string | undefined {
  if (!baseEmail?.includes("@")) {
    return undefined;
  }

  const [localPart, domain] = baseEmail.split("@");
  const hostKey = hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);

  return `${localPart}+${hostKey}@${domain}`;
}

export function buildMailboxQuery(emailAlias: string): string {
  return `is:unread to:${emailAlias} newer_than:2d`;
}

export function generateCredentialRef(hostname: string, emailAlias: string): string {
  const hostKey = hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const emailKey = emailAlias.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48);
  return `cred-${hostKey}-${emailKey}`;
}

export function generateSitePassword(length = 20): string {
  const raw = randomBytes(Math.max(length, 16))
    .toString("base64url")
    .replace(/[-_]/g, "A");
  return `${raw.slice(0, Math.max(length - 2, 12))}9!`;
}

export function generateSignupUsername(name: string | undefined, hostname: string): string {
  const base = (name || hostname)
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 18);
  const suffix = randomBytes(3).toString("hex").slice(0, 6);
  return `${base || "submitter"}_${suffix}`.slice(0, 24);
}
