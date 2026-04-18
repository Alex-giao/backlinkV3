import fs from "node:fs";
import path from "node:path";

import { ensureDirectory, getRuntimeSkillsRoot, getSkillDir, listSkillNames, skillSourceRoot } from "./skills-lib.mjs";

const skillNames = listSkillNames(skillSourceRoot);
if (skillNames.length === 0) {
  console.error(`No skill sources found in ${skillSourceRoot}.`);
  process.exit(1);
}

const runtimeSkillsRoot = getRuntimeSkillsRoot();
ensureDirectory(runtimeSkillsRoot);

for (const skillName of skillNames) {
  const sourceDir = getSkillDir(skillSourceRoot, skillName);
  const targetDir = path.join(runtimeSkillsRoot, skillName);

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });

  console.log(`Synced ${skillName} -> ${targetDir}`);
}
