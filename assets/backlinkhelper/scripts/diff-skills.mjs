import fs from "node:fs";
import path from "node:path";

import { collectFiles, getRuntimeSkillsRoot, getSkillDir, listSkillNames, readUtf8, skillSourceRoot } from "./skills-lib.mjs";

const runtimeSkillsRoot = getRuntimeSkillsRoot();
const skillNames = listSkillNames(skillSourceRoot);

if (skillNames.length === 0) {
  console.error(`No skill sources found in ${skillSourceRoot}.`);
  process.exit(1);
}

let hasDiff = false;

for (const skillName of skillNames) {
  const sourceDir = getSkillDir(skillSourceRoot, skillName);
  const targetDir = path.join(runtimeSkillsRoot, skillName);

  if (!fs.existsSync(targetDir)) {
    console.log(`${skillName}: missing installed copy at ${targetDir}`);
    hasDiff = true;
    continue;
  }

  const sourceFiles = collectFiles(sourceDir);
  const targetFiles = collectFiles(targetDir);
  const allFiles = [...new Set([...sourceFiles, ...targetFiles])].sort();

  for (const relativePath of allFiles) {
    const sourcePath = path.join(sourceDir, relativePath);
    const targetPath = path.join(targetDir, relativePath);
    const sourceExists = fs.existsSync(sourcePath);
    const targetExists = fs.existsSync(targetPath);

    if (!sourceExists) {
      console.log(`${skillName}: installed copy has extra file ${relativePath}`);
      hasDiff = true;
      continue;
    }

    if (!targetExists) {
      console.log(`${skillName}: installed copy is missing file ${relativePath}`);
      hasDiff = true;
      continue;
    }

    if (readUtf8(sourcePath) !== readUtf8(targetPath)) {
      console.log(`${skillName}: file differs ${relativePath}`);
      hasDiff = true;
    }
  }
}

if (hasDiff) {
  process.exit(1);
}

console.log("Repo skill sources and installed copies are in sync.");
