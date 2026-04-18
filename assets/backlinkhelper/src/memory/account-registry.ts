import {
  loadAccountRecord,
  saveAccountRecord,
} from "./data-store.js";
import type { AccountRecord } from "../shared/types.js";

export async function getAccountForHostname(hostname: string): Promise<AccountRecord | undefined> {
  return loadAccountRecord(hostname);
}

export async function upsertAccountRecord(args: {
  hostname: string;
  email: string;
  emailAlias: string;
  authMode: AccountRecord["auth_mode"];
  verified: boolean;
  loginUrl?: string;
  submitUrl?: string;
  credentialRef?: string;
  registrationResult: string;
}): Promise<AccountRecord> {
  const existing = await loadAccountRecord(args.hostname);
  const now = new Date().toISOString();

  const account: AccountRecord = {
    hostname: args.hostname,
    email: args.email,
    email_alias: args.emailAlias,
    auth_mode: args.authMode,
    verified: args.verified,
    login_url: args.loginUrl ?? existing?.login_url,
    submit_url: args.submitUrl ?? existing?.submit_url,
    credential_ref: args.credentialRef ?? existing?.credential_ref,
    created_at: existing?.created_at ?? now,
    last_used_at: now,
    last_registration_result: args.registrationResult,
  };

  await saveAccountRecord(account);
  return account;
}

export async function touchAccountUsage(hostname: string): Promise<AccountRecord | undefined> {
  const existing = await loadAccountRecord(hostname);
  if (!existing) {
    return undefined;
  }

  const updated: AccountRecord = {
    ...existing,
    last_used_at: new Date().toISOString(),
  };
  await saveAccountRecord(updated);
  return updated;
}
