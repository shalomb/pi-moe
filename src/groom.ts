import fs from "node:fs";
import path from "node:path";
import {
  bootstrapXdgState,
  estimateTokens,
  getStatePaths,
  validateFocus,
  type ValidationResult,
} from "./xdg.ts";

export interface FocusSectionUpdates {
  activeFocus?: string[];
  runningDelegates?: string[];
  standingAnchors?: string[];
}

export interface FocusUpdateResult {
  content: string;
  tokenCount: number;
  validation: ValidationResult;
}

/**
 * Reads focus.md, validates the 1000-token budget, and returns the compact <moe_focus> prompt section.
 * Truncates with a clear warning if ever over budget so Moe's prompt never bloats.
 */
export function renderFocusSection(stateDir?: string): string {
  const paths = getStatePaths(stateDir);
  if (!fs.existsSync(paths.focusPath)) {
    bootstrapXdgState({ stateDir });
  }

  let content = fs.readFileSync(paths.focusPath, "utf8");
  const maxTokens = 1000;
  let tokens = estimateTokens(content);

  if (tokens > maxTokens) {
    const allowedLength = maxTokens * 4 - 150;
    content =
      content.slice(0, allowedLength) +
      "\n\n[WARNING: focus.md exceeded 1000 tokens and was truncated]";
  }

  return `<moe_focus>\n${content.trim()}\n</moe_focus>`;
}

/**
 * Builds instructions for session_before_compact / compaction so durable facts/decisions
 * are preserved as semantic anchors and raw tool noise is discarded.
 */
export function buildCompactionGroomingInstructions(customInstructions?: string): string {
  const parts = [
    "Memory Grooming Compaction Directives:",
    "1. Preserve durable facts, architectural decisions, and current progress as semantic anchors.",
    "2. Discard raw tool noise, repetitive logs, large diff noise, and transient worker polling.",
    "3. Keep track of open delegate tasks, active focus goals, and any known skill friction.",
  ];

  if (customInstructions && customInstructions.trim()) {
    parts.push(`Additional Instructions: ${customInstructions.trim()}`);
  }

  return parts.join("\n");
}

function deduplicateLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(line);
    }
  }
  return out;
}

/**
 * Updates sections (activeFocus, runningDelegates, standingAnchors) in focus.md
 * while enforcing the 1000-token budget and deduplicating lines.
 */
export function updateActiveFocus(
  stateDir: string | undefined,
  updates: FocusSectionUpdates,
): FocusUpdateResult {
  const paths = getStatePaths(stateDir);
  if (!fs.existsSync(paths.focusPath)) {
    bootstrapXdgState({ stateDir });
  }

  const raw = fs.readFileSync(paths.focusPath, "utf8");
  const now = new Date().toISOString();

  // Parse existing sections
  let activeFocusLines: string[] = [];
  let runningDelegatesLines: string[] = [];
  let standingAnchorsLines: string[] = [];

  const lines = raw.split(/\r?\n/);
  let currentSection: "header" | "active" | "delegates" | "anchors" | "other" = "header";

  for (const line of lines) {
    if (line.startsWith("## Active Focus")) {
      currentSection = "active";
      continue;
    } else if (line.startsWith("## Running Delegates")) {
      currentSection = "delegates";
      continue;
    } else if (line.startsWith("## Standing Anchors")) {
      currentSection = "anchors";
      continue;
    } else if (line.startsWith("## ")) {
      currentSection = "other";
      continue;
    }

    if (currentSection === "active") {
      activeFocusLines.push(line);
    } else if (currentSection === "delegates") {
      runningDelegatesLines.push(line);
    } else if (currentSection === "anchors") {
      standingAnchorsLines.push(line);
    }
  }

  if (updates.activeFocus) {
    activeFocusLines = updates.activeFocus.map((item) =>
      item.startsWith("- ") ? item : `- ${item}`,
    );
  }
  if (updates.runningDelegates) {
    if (updates.runningDelegates.length === 0) {
      runningDelegatesLines = ["(none)"];
    } else {
      runningDelegatesLines = updates.runningDelegates.map((item) =>
        item.startsWith("- ") || item === "(none)" ? item : `- ${item}`,
      );
    }
  }
  if (updates.standingAnchors) {
    standingAnchorsLines = updates.standingAnchors.map((item) =>
      item.startsWith("- ") ? item : `- ${item}`,
    );
  }

  // Deduplicate lines
  const dedupActive = deduplicateLines(activeFocusLines);
  const dedupDelegates = deduplicateLines(runningDelegatesLines);
  const dedupAnchors = deduplicateLines(standingAnchorsLines);

  const newFocusContent = `---
id: focus
updated: ${now}
max_tokens: 1000
---

## Active Focus
${dedupActive.length ? dedupActive.join("\n") : "- Operational"}

## Running Delegates
${dedupDelegates.length ? dedupDelegates.join("\n") : "(none)"}

## Standing Anchors
${dedupAnchors.length ? dedupAnchors.join("\n") : "- TDD & Farley index\n- ACP Conventional Commits"}
`;

  fs.writeFileSync(paths.focusPath, newFocusContent, "utf8");
  const validation = validateFocus(newFocusContent);

  return {
    content: newFocusContent,
    tokenCount: estimateTokens(newFocusContent),
    validation,
  };
}
