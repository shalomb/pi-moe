import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DispatchReceipt } from "./dispatch.ts";
import { resolveStateDir } from "./xdg.ts";

export type SkillStatus = "verified" | "needs-script" | "draft";

export interface SkillEntry {
  status: SkillStatus;
  roles: string[];
  deterministicEntrypoints: string[];
  lastVerified: string;
  frictionCount: number;
}

export interface SkillRegister {
  version: number;
  lastUpdated?: string;
  skills: Record<string, SkillEntry>;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REGISTER_PATH = path.resolve(__dirname, "../loadouts/skill-register.json");

export function getRegisterPath(customPath?: string): string {
  if (customPath) return path.resolve(customPath);
  return DEFAULT_REGISTER_PATH;
}

export function loadSkillRegister(registerPath?: string): SkillRegister {
  const file = getRegisterPath(registerPath);
  if (!fs.existsSync(file)) {
    return {
      version: 1,
      skills: {},
    };
  }
  const content = fs.readFileSync(file, "utf8");
  return JSON.parse(content) as SkillRegister;
}

export function saveSkillRegister(register: SkillRegister, registerPath?: string): void {
  const file = getRegisterPath(registerPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(register, null, 2), "utf8");
}

export interface SkillFrictionRecordResult {
  recorded: boolean;
  frictionItems: string[];
  memoryPath?: string;
}

export function recordSkillFriction(
  receipt: DispatchReceipt,
  registerPath?: string,
  stateDir?: string,
): SkillFrictionRecordResult {
  const friction = receipt.skillFriction || [];
  if (friction.length === 0) {
    return { recorded: false, frictionItems: [] };
  }

  const resolvedStateDir = stateDir ? path.resolve(stateDir) : resolveStateDir();
  const memoryDir = path.join(resolvedStateDir, "memory");
  const memoryPath = path.join(memoryDir, "skill-friction.md");
  fs.mkdirSync(memoryDir, { recursive: true });

  const register = loadSkillRegister(registerPath);
  const now = new Date().toISOString();

  // Update register
  for (const item of friction) {
    // Try to detect skill name from item string (e.g. "todo-navigator: failed..." or "skill_name ...")
    const words = item.split(/[\s:,\(\)]+/).filter(Boolean);
    let matchedSkill = "";
    for (const w of words) {
      if (register.skills[w]) {
        matchedSkill = w;
        break;
      }
    }
    if (!matchedSkill && words.length > 0) {
      matchedSkill = words[0];
    }

    if (matchedSkill) {
      if (!register.skills[matchedSkill]) {
        register.skills[matchedSkill] = {
          status: "needs-script",
          roles: [receipt.role],
          deterministicEntrypoints: [],
          lastVerified: now,
          frictionCount: 1,
        };
      } else {
        register.skills[matchedSkill].frictionCount =
          (register.skills[matchedSkill].frictionCount || 0) + 1;
        register.skills[matchedSkill].status = "needs-script";
      }
    }
  }

  register.lastUpdated = now;
  saveSkillRegister(register, registerPath);

  // Append entry to memory/skill-friction.md with valid Tier-2 YAML frontmatter
  let existingContent = "";
  if (fs.existsSync(memoryPath)) {
    existingContent = fs.readFileSync(memoryPath, "utf8");
  }

  const frictionLines = friction.map((f) => `- [ ] ${f}`).join("\n");
  const newEntrySection = `
### ${now} (${receipt.role}: ${receipt.id})
- **Task**: ${receipt.task}
- **Exit Code**: ${receipt.exitCode} (${receipt.status})
- **Duration**: ${receipt.durationMs}ms
- **Friction Items**:
${frictionLines}
`;

  if (!existingContent) {
    const initialNote = `---
id: skill-friction
tags: [skill-friction, reliability, triage]
created: ${now}
modified: ${now}
---

# Skill Reliability & Friction Log

${newEntrySection.trim()}
`;
    fs.writeFileSync(memoryPath, initialNote, "utf8");
  } else {
    // Update modified timestamp in frontmatter and append body section
    let updatedContent = existingContent;
    if (updatedContent.match(/modified:\s*[^\n\r]+/)) {
      updatedContent = updatedContent.replace(
        /modified:\s*[^\n\r]+/,
        `modified: ${now}`,
      );
    }
    updatedContent = updatedContent.trimEnd() + "\n" + newEntrySection;
    fs.writeFileSync(memoryPath, updatedContent, "utf8");
  }

  return {
    recorded: true,
    frictionItems: friction,
    memoryPath,
  };
}
