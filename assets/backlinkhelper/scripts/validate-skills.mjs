import path from "node:path";

import { getRuntimeSkillsRoot, getSkillDir, listSkillNames, skillSourceRoot, validateSkillDir } from "./skills-lib.mjs";

const includeInstalled = process.argv.includes("--installed");
const sourceSkillNames = listSkillNames(skillSourceRoot);

if (sourceSkillNames.length === 0) {
  console.error(`No skill sources found in ${skillSourceRoot}.`);
  process.exit(1);
}

const allErrors = [];

for (const skillName of sourceSkillNames) {
  const sourceDir = getSkillDir(skillSourceRoot, skillName);
  allErrors.push(...validateSkillDir(sourceDir).map((error) => `[source] ${error}`));

  if (includeInstalled) {
    const installedDir = path.join(getRuntimeSkillsRoot(), skillName);
    allErrors.push(...validateSkillDir(installedDir).map((error) => `[installed] ${error}`));
  }
}

if (allErrors.length > 0) {
  for (const error of allErrors) {
    console.error(error);
  }
  process.exit(1);
}

console.log(
  includeInstalled
    ? `Validated ${sourceSkillNames.length} skill source(s) and installed copy/copies.`
    : `Validated ${sourceSkillNames.length} repo skill source(s).`,
);
