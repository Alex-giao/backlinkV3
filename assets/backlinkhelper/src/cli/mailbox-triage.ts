import { triageRecentUnreadEmails } from "../shared/gog.js";

export async function runMailboxTriageCommand(args: {
  mailboxQuery?: string;
  hostname?: string;
  primaryEmail?: string;
  emailAlias?: string;
  account?: string;
  windowHours?: number;
  maxSearch?: number;
  maxCandidates?: number;
}): Promise<void> {
  const result = await triageRecentUnreadEmails({
    mailboxQuery: args.mailboxQuery,
    hostname: args.hostname,
    primaryEmail: args.primaryEmail,
    emailAlias: args.emailAlias,
    account: args.account,
    windowHours: args.windowHours,
    maxSearch: args.maxSearch,
    maxCandidates: args.maxCandidates,
  });

  console.log(JSON.stringify(result, null, 2));
}
