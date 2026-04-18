import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const repoRoot = path.resolve(__dirname, "..");
export const skillSourceRoot = path.join(repoRoot, "codex-skills");

export function getCodexHome() {
  return process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
}

export function getRuntimeSkillsRoot() {
  const explicitRoot = process.env.SKILL_RUNTIME_ROOT?.trim();
  if (explicitRoot) {
    return explicitRoot;
  }

  const hermesRoot = process.env.HERMES_SKILLS_ROOT?.trim();
  if (hermesRoot) {
    return hermesRoot;
  }

  const defaultHermesRoot = path.join(os.homedir(), ".hermes", "skills", "openclaw-imports");
  if (fs.existsSync(defaultHermesRoot)) {
    return defaultHermesRoot;
  }

  return path.join(getCodexHome(), "skills");
}

export function listSkillNames(root = skillSourceRoot) {
  if (!fs.existsSync(root)) {
    return [];
  }

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function getSkillDir(root, skillName) {
  return path.join(root, skillName);
}

export function collectFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      files.push(path.relative(rootDir, fullPath));
    }
  }

  if (fs.existsSync(rootDir)) {
    walk(rootDir);
  }

  return files.sort();
}

export function readUtf8(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

export function extractFrontmatter(markdown) {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { frontmatter: null, body: markdown };
  }

  const closingIndex = lines.findIndex((line, index) => index > 0 && line === "---");
  if (closingIndex === -1) {
    return { frontmatter: null, body: markdown };
  }

  return {
    frontmatter: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

export function parseSimpleYamlMap(yamlText) {
  const result = {};

  for (const rawLine of yamlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    const value = rawValue.replace(/^['"]|['"]$/g, "").trim();
    result[key] = value;
  }

  return result;
}

function collectRelativeMarkdownLinks(markdown) {
  const links = [];
  const regex = /\[[^\]]+\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const target = match[1].trim();
    if (!target || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("/")) {
      continue;
    }
    if (target.startsWith("#")) {
      continue;
    }

    const withoutAnchor = target.split("#")[0];
    if (withoutAnchor) {
      links.push(withoutAnchor);
    }
  }

  return links;
}

export function validateSkillDir(skillDir) {
  const errors = [];
  const skillName = path.basename(skillDir);
  const skillMarkdownPath = path.join(skillDir, "SKILL.md");
  const openAiYamlPath = path.join(skillDir, "agents", "openai.yaml");

  if (!fs.existsSync(skillMarkdownPath)) {
    errors.push(`Missing SKILL.md in ${skillDir}`);
    return errors;
  }

  const skillMarkdown = readUtf8(skillMarkdownPath);
  const { frontmatter, body } = extractFrontmatter(skillMarkdown);

  if (!frontmatter) {
    errors.push(`${skillName}: SKILL.md is missing YAML frontmatter.`);
  } else {
    const parsed = parseSimpleYamlMap(frontmatter);
    if (!parsed.name) {
      errors.push(`${skillName}: frontmatter is missing "name".`);
    } else if (parsed.name !== skillName) {
      errors.push(`${skillName}: frontmatter name "${parsed.name}" does not match directory name.`);
    }

    if (!parsed.description) {
      errors.push(`${skillName}: frontmatter is missing "description".`);
    }
  }

  if (!body.trim()) {
    errors.push(`${skillName}: SKILL.md body is empty.`);
  }

  for (const relativeLink of collectRelativeMarkdownLinks(skillMarkdown)) {
    const targetPath = path.join(skillDir, relativeLink);
    if (!fs.existsSync(targetPath)) {
      errors.push(`${skillName}: SKILL.md references missing relative file "${relativeLink}".`);
    }
  }

  if (!fs.existsSync(openAiYamlPath)) {
    errors.push(`${skillName}: missing agents/openai.yaml.`);
  } else {
    const openAiYaml = readUtf8(openAiYamlPath);
    for (const requiredSnippet of [
      "display_name:",
      "short_description:",
      "default_prompt:",
      "allow_implicit_invocation:",
    ]) {
      if (!openAiYaml.includes(requiredSnippet)) {
        errors.push(`${skillName}: agents/openai.yaml is missing "${requiredSnippet}".`);
      }
    }
  }

  return errors;
}

export function ensureDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true });
}
