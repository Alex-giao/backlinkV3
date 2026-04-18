import { getProfileFilePath, writeJsonFile } from "../memory/data-store.js";
import { loadOrCreatePromotedProfile, applyDossierUpdates } from "../shared/promoted-profile.js";
import type { PromotedProfileFieldSourceType } from "../shared/types.js";

function parseAssignments(assignments: string[]): Array<{ key: string; value: string }> {
  return assignments.map((assignment) => {
    const index = assignment.indexOf("=");
    if (index <= 0) {
      throw new Error(`Invalid --set value: ${assignment}. Expected key=value.`);
    }
    const key = assignment.slice(0, index).trim();
    const value = assignment.slice(index + 1).trim();
    if (!key || !value) {
      throw new Error(`Invalid --set value: ${assignment}. Expected key=value.`);
    }
    return { key, value };
  });
}

export async function runUpdatePromotedDossierCommand(args: {
  promotedUrl: string;
  updates: string[];
  sourceType?: PromotedProfileFieldSourceType;
}): Promise<void> {
  const profile = await loadOrCreatePromotedProfile({ promotedUrl: args.promotedUrl });
  const nextProfile = applyDossierUpdates({
    profile,
    updates: parseAssignments(args.updates),
    sourceType: args.sourceType ?? "user_confirmed",
  });
  await writeJsonFile(getProfileFilePath(nextProfile.hostname), nextProfile);
  console.log(JSON.stringify({
    ok: true,
    promoted_hostname: nextProfile.hostname,
    updated_keys: Object.keys(nextProfile.dossier_fields ?? {}),
    source_type: args.sourceType ?? "user_confirmed",
  }, null, 2));
}
