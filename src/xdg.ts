import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export interface StatePaths {
  stateDir: string;
  focusPath: string;
  memoryDir: string;
  receiptsDir: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  field?: string;
}

export interface ValidationResult {
  valid: boolean;
  tokenCount: number;
  diagnostics: Diagnostic[];
  frontmatter?: Record<string, unknown>;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
  if (env.MOE_STATE_DIR && env.MOE_STATE_DIR.trim() !== "") {
    return path.resolve(env.MOE_STATE_DIR.trim());
  }
  if (env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim() !== "") {
    return path.resolve(env.XDG_STATE_HOME.trim(), "pi-moe");
  }
  const home = env.HOME || os.homedir();
  return path.resolve(home, ".local", "state", "pi-moe");
}

export function getStatePaths(stateDir?: string): StatePaths {
  const dir = stateDir ? path.resolve(stateDir) : resolveStateDir();
  return {
    stateDir: dir,
    focusPath: path.join(dir, "focus.md"),
    memoryDir: path.join(dir, "memory"),
    receiptsDir: path.join(dir, "receipts"),
  };
}

export function parseSimpleYamlFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content, hasFrontmatter: false };
  }

  const rawYaml = match[1];
  const body = match[2];
  const frontmatter: Record<string, unknown> = {};

  const lines = rawYaml.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const arrayItemMatch = line.match(/^\s*-\s+(.*)$/);
    if (arrayItemMatch && currentKey) {
      if (!currentArray) {
        currentArray = [];
        frontmatter[currentKey] = currentArray;
      }
      let val = arrayItemMatch[1].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      currentArray.push(val);
      continue;
    }

    const kvMatch = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1].trim();
      currentArray = null;
      let rawVal = kvMatch[2].trim();

      if (rawVal === "") {
        // May be followed by array lines
        frontmatter[currentKey] = null;
      } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
        const inner = rawVal.slice(1, -1).trim();
        if (inner.length === 0) {
          frontmatter[currentKey] = [];
        } else {
          frontmatter[currentKey] = inner
            .split(",")
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
        }
      } else {
        if (
          (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
          (rawVal.startsWith("'") && rawVal.endsWith("'"))
        ) {
          rawVal = rawVal.slice(1, -1);
        } else if (!Number.isNaN(Number(rawVal)) && rawVal !== "") {
          frontmatter[currentKey] = Number(rawVal);
          continue;
        }
        frontmatter[currentKey] = rawVal;
      }
    }
  }

  return { frontmatter, body, hasFrontmatter: true };
}

export function validateFocus(content: string): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const tokenCount = estimateTokens(content);

  const { frontmatter, body, hasFrontmatter } = parseSimpleYamlFrontmatter(content);

  if (!hasFrontmatter) {
    diagnostics.push({
      code: "MISSING_FRONTMATTER",
      message: "focus.md must start with YAML frontmatter bounded by ---",
    });
  } else {
    if (frontmatter.id !== "focus") {
      diagnostics.push({
        code: "INVALID_FIELD",
        field: "id",
        message: `Field 'id' must be exactly 'focus' (got '${frontmatter.id}')`,
      });
    }
    if (!frontmatter.updated) {
      diagnostics.push({
        code: "MISSING_FIELD",
        field: "updated",
        message: "Field 'updated' timestamp is required",
      });
    }
    if (frontmatter.max_tokens !== undefined && Number(frontmatter.max_tokens) !== 1000) {
      diagnostics.push({
        code: "INVALID_FIELD",
        field: "max_tokens",
        message: `Field 'max_tokens' must be 1000 (got ${frontmatter.max_tokens})`,
      });
    }
  }

  const requiredSections = [
    "## Active Focus",
    "## Running Delegates",
    "## Standing Anchors",
  ];

  for (const section of requiredSections) {
    if (!content.includes(section)) {
      diagnostics.push({
        code: "MISSING_SECTION",
        message: `Required section '${section}' is missing from focus.md`,
      });
    }
  }

  const maxBudget = (frontmatter && Number(frontmatter.max_tokens)) || 1000;
  if (tokenCount > maxBudget) {
    diagnostics.push({
      code: "TOKEN_BUDGET_EXCEEDED",
      message: `Token budget exceeded: ${tokenCount} tokens > ${maxBudget} token limit`,
    });
  }

  return {
    valid: diagnostics.length === 0,
    tokenCount,
    diagnostics,
    frontmatter,
  };
}

export function validateMemoryNote(content: string): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const tokenCount = estimateTokens(content);
  const { frontmatter, hasFrontmatter } = parseSimpleYamlFrontmatter(content);

  if (!hasFrontmatter) {
    diagnostics.push({
      code: "MISSING_FRONTMATTER",
      message: "Memory note must start with YAML frontmatter bounded by ---",
    });
  } else {
    if (!frontmatter.id || typeof frontmatter.id !== "string" || frontmatter.id.trim() === "") {
      diagnostics.push({
        code: "MISSING_FIELD",
        field: "id",
        message: "Memory note frontmatter must contain a valid 'id'",
      });
    }

    if (
      !frontmatter.tags ||
      (!Array.isArray(frontmatter.tags) && typeof frontmatter.tags !== "string") ||
      (Array.isArray(frontmatter.tags) && frontmatter.tags.length === 0)
    ) {
      diagnostics.push({
        code: "MISSING_FIELD",
        field: "tags",
        message: "Memory note frontmatter must contain 'tags' (array or string list)",
      });
    }

    if (!frontmatter.created && !frontmatter.modified && !frontmatter.updated) {
      diagnostics.push({
        code: "MISSING_FIELD",
        field: "created",
        message: "Memory note frontmatter must specify 'created' or 'modified' or 'updated'",
      });
    }
  }

  return {
    valid: diagnostics.length === 0,
    tokenCount,
    diagnostics,
    frontmatter,
  };
}

export function generateInitialFocusMd(now: string = new Date().toISOString()): string {
  return `---
id: focus
updated: ${now}
max_tokens: 1000
---

## Active Focus
- pi-moe operational and ready for task dispatch.

## Running Delegates
(none)

## Standing Anchors
- TDD & Farley index
- ACP Conventional Commits
- Diátaxis documentation
`;
}

export interface BootstrapResult {
  stateDir: string;
  focusPath: string;
  memoryDir: string;
  receiptsDir: string;
  createdFocus: boolean;
  validation: ValidationResult;
}

export function bootstrapXdgState(options: {
  stateDir?: string;
  now?: string;
} = {}): BootstrapResult {
  const paths = getStatePaths(options.stateDir);

  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.memoryDir, { recursive: true });
  fs.mkdirSync(paths.receiptsDir, { recursive: true });

  let createdFocus = false;
  if (!fs.existsSync(paths.focusPath)) {
    const initialContent = generateInitialFocusMd(options.now);
    fs.writeFileSync(paths.focusPath, initialContent, "utf8");
    createdFocus = true;
  }

  const focusContent = fs.readFileSync(paths.focusPath, "utf8");
  const validation = validateFocus(focusContent);

  return {
    ...paths,
    createdFocus,
    validation,
  };
}
