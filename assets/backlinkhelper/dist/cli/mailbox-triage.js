import { triageRecentUnreadEmails } from "../shared/gog.js";
export async function runMailboxTriageCommand(args) {
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
