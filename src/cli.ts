import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { resolveStateDir, getStatePaths } from "./xdg.ts";
import { executeDispatch, type RoleName } from "./dispatch.ts";

export interface ParsedArgs {
  dryRun: boolean;
  json: boolean;
  fast: boolean;
  role?: string;
  project?: string;
  sendToDaemon: boolean;
  utterance: string;
}

export type IntentKind = "status" | "todo_ensure" | "memory_capture" | "fast_question" | "delegate";

export interface ClassifiedIntent {
  kind: IntentKind;
  repo?: string;
  taskTitle?: string;
  targetMode?: "memory" | "obsidian";
  prompt?: string;
  role?: string;
  command?: string[];
}

export interface CliExecutionResult {
  intent: ClassifiedIntent;
  dryRun: boolean;
  output: string;
  data?: unknown;
}

/**
 * Strips leading separator ('-' or '--') and folds non-flag words into one natural utterance string,
 * while respecting control flags: --dry-run, --json, --fast, --role <role>, --project <repo>, --send.
 */
export function foldCliArgs(argv: string[]): ParsedArgs {
  let dryRun = false;
  let json = false;
  let fast = false;
  let sendToDaemon = process.env.MOE_SEND_TO_DAEMON === "1";
  let role: string | undefined;
  let project: string | undefined;

  const words: string[] = [];
  let i = 0;

  // If first token is "-" or "--", skip it
  if (argv.length > 0 && (argv[0] === "-" || argv[0] === "--")) {
    i = 1;
  }

  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--dry-run") {
      dryRun = true;
      i++;
    } else if (arg === "--json") {
      json = true;
      i++;
    } else if (arg === "--fast") {
      fast = true;
      i++;
    } else if (arg === "--send") {
      sendToDaemon = true;
      i++;
    } else if (arg === "--role" && i + 1 < argv.length) {
      role = argv[i + 1];
      i += 2;
    } else if (arg.startsWith("--role=")) {
      role = arg.slice("--role=".length);
      i++;
    } else if (arg === "--project" && i + 1 < argv.length) {
      project = argv[i + 1];
      i += 2;
    } else if (arg.startsWith("--project=")) {
      project = arg.slice("--project=".length);
      i++;
    } else if (arg === "--" || arg === "-") {
      // separator between flags and utterance
      i++;
    } else {
      words.push(arg);
      i++;
    }
  }

  const utterance = words.join(" ").trim();
  return {
    dryRun,
    json,
    fast,
    role,
    project,
    sendToDaemon,
    utterance,
  };
}

/**
 * Deterministic Fast-Path Classifier
 */
export function classifyUtterance(utterance: string): ClassifiedIntent {
  const text = utterance.trim();

  // 1. Status / focus
  if (!text || text === "status" || text === "focus") {
    return { kind: "status" };
  }

  // 2. Todo ensure patterns:
  // e.g. "can you ensure we have a task down for project <repo> [to/for] <task>"
  // e.g. "todo <repo>: <task>"
  // e.g. "task add <repo>: <task>"
  const ensureRegex = /(?:can you\s+)?ensure (?:we have )?a task (?:down )?for project\s+([a-zA-Z0-9_-]+)\s+(?:to|for)\s+(.*)/i;
  const ensureMatch = text.match(ensureRegex);
  if (ensureMatch) {
    return {
      kind: "todo_ensure",
      repo: ensureMatch[1].trim(),
      taskTitle: ensureMatch[2].trim(),
    };
  }

  const todoColonRegex = /^(?:todo|task)\s+([a-zA-Z0-9_-]+):\s*(.*)$/i;
  const colonMatch = text.match(todoColonRegex);
  if (colonMatch) {
    return {
      kind: "todo_ensure",
      repo: colonMatch[1].trim(),
      taskTitle: colonMatch[2].trim(),
    };
  }

  // 3. Memory capture patterns:
  // e.g. "note: <text>", "remember <text>", "jot down <text>"
  const noteMatch = text.match(/^(?:note:\s*|remember\s+|jot\s+down\s+)(.*)$/i);
  if (noteMatch) {
    let captured = noteMatch[1].trim();
    let targetMode: "memory" | "obsidian" = "memory";
    if (captured.toLowerCase().includes("obsidian") || captured.toLowerCase().includes("vault")) {
      targetMode = "obsidian";
      // optionally clean prefix like "vault note: "
      captured = captured.replace(/^(?:vault note:\s*|vault\s+note\s+|obsidian\s+note:\s*)/i, "");
    }
    return {
      kind: "memory_capture",
      targetMode,
      prompt: captured,
    };
  }

  // 4. Delegate patterns:
  // e.g. "delegate to <role> <prompt>"
  const delegateMatch = text.match(/^delegate(?:\s+to)?\s+([a-zA-Z0-9_-]+)\s+(.*)$/i);
  if (delegateMatch) {
    return {
      kind: "delegate",
      role: delegateMatch[1].trim(),
      prompt: delegateMatch[2].trim(),
    };
  }

  // 5. Fast question / default fallback
  return {
    kind: "fast_question",
    prompt: text,
  };
}

/**
 * Resolves a repo name against local sibling directories or gum projects output
 */
export function resolveProjectRepo(repoName: string): string | null {
  const cleanName = repoName.trim();
  // 1. Direct path check
  if (path.isAbsolute(cleanName) && fs.existsSync(cleanName)) {
    return cleanName;
  }

  // 2. Sibling directory under /media/psf/Home/projects/shalomb/<repo>
  const shalombDir = "/media/psf/Home/projects/shalomb";
  const siblingPath = path.join(shalombDir, cleanName);
  if (fs.existsSync(siblingPath)) {
    return siblingPath;
  }

  // 3. Current working directory match
  const cwd = process.cwd();
  if (path.basename(cwd).toLowerCase() === cleanName.toLowerCase()) {
    return cwd;
  }

  // 4. Try `gum projects --format simple`
  try {
    const res = spawnSync("gum", ["projects", "--format", "simple"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (res.status === 0 && res.stdout) {
      const lines = res.stdout.split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        if (line.toLowerCase().endsWith("/" + cleanName.toLowerCase()) || line.toLowerCase() === cleanName.toLowerCase()) {
          return line;
        }
      }
      // partial basename match
      for (const line of lines) {
        const base = path.basename(line).toLowerCase();
        if (base.includes(cleanName.toLowerCase())) {
          return line;
        }
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Immediate terminal status handler (<20ms)
 */
export function handleStatus(stateDir: string = resolveStateDir()): string {
  const paths = getStatePaths(stateDir);
  let focusExcerpt = "(no focus.md found)";
  if (fs.existsSync(paths.focusPath)) {
    const content = fs.readFileSync(paths.focusPath, "utf8");
    const lines = content.split(/\r?\n/);
    const activeIdx = lines.findIndex((l) => l.trim().startsWith("## Active Focus"));
    if (activeIdx !== -1) {
      const nextHeaderIdx = lines.findIndex((l, i) => i > activeIdx && l.startsWith("## "));
      const slice = lines.slice(activeIdx + 1, nextHeaderIdx === -1 ? undefined : nextHeaderIdx);
      focusExcerpt = slice.map((s) => s.trim()).filter(Boolean).join("\n");
    } else {
      focusExcerpt = lines.slice(0, 10).join("\n");
    }
  }

  let recentReceipts: string[] = [];
  if (fs.existsSync(paths.receiptsDir)) {
    const files = fs.readdirSync(paths.receiptsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
      .slice(0, 3);

    recentReceipts = files.map((f) => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(paths.receiptsDir, f), "utf8"));
        return `- ${f.replace(".json", "")}: [${raw.role ?? "delegate"}] ${raw.status ?? "done"} - ${raw.task ? raw.task.slice(0, 50) : ""}`;
      } catch {
        return `- ${f}`;
      }
    });
  }

  return `Moe Companion Status:
State: ${paths.stateDir}
Focus:
${focusExcerpt}
Recent Receipts:
${recentReceipts.length > 0 ? recentReceipts.join("\n") : "(none)"}`;
}

/**
 * Handles todo_ensure idempotently
 */
export function handleTodoEnsure(repoName: string, taskTitle: string, dryRun: boolean): { output: string; data?: unknown } {
  const repoPath = resolveProjectRepo(repoName);
  if (!repoPath) {
    return {
      output: `Could not resolve repository '${repoName}'.`,
      data: { error: "REPO_NOT_FOUND", repo: repoName },
    };
  }

  if (dryRun) {
    return {
      output: `[dry-run] Would check open tasks in ${repoPath} and ensure task: "${taskTitle}"`,
      data: { repoPath, taskTitle, action: "todo_ensure" },
    };
  }

  // 1. Run `todo list` in repoPath
  const listRes = spawnSync("todo", ["list"], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 3000,
  });

  const existing = listRes.stdout || "";
  if (existing.toLowerCase().includes(taskTitle.toLowerCase())) {
    return {
      output: `Task already exists in ${repoName}: "${taskTitle}"`,
      data: { repoPath, taskTitle, exists: true },
    };
  }

  // 2. Add task
  const addRes = spawnSync("todo", ["add", taskTitle], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 3000,
  });

  return {
    output: `Task ensured in ${repoName}: ${addRes.stdout.trim() || taskTitle}`,
    data: { repoPath, taskTitle, created: true, stdout: addRes.stdout.trim() },
  };
}

/**
 * Handles memory capture via ob-cli
 */
export function handleMemoryCapture(prompt: string, targetMode: "memory" | "obsidian", dryRun: boolean): { output: string; data?: unknown } {
  const args = targetMode === "obsidian"
    ? ["--mode=obsidian", "Incoming.md", "--capture", prompt, "--tags", "inbox,cli", "--title", "Moe Inbox"]
    : ["--mode=memory", "inbox.md", "--capture", prompt, "--tags", "inbox,cli", "--title", "Moe Inbox"];

  if (dryRun) {
    return {
      output: `[dry-run] Would execute: ob-cli ${args.map((a) => JSON.stringify(a)).join(" ")}`,
      data: { command: ["ob-cli", ...args] },
    };
  }

  const res = spawnSync("ob-cli", args, { encoding: "utf8", timeout: 5000 });
  return {
    output: res.stdout.trim() || `Captured to ${targetMode} inbox.`,
    data: { exitCode: res.status, stdout: res.stdout.trim() },
  };
}

/**
 * Fast-path question execution (or dry-run)
 */
export function handleFastQuestion(prompt: string, options: ParsedArgs): { output: string; data?: unknown } {
  if (options.dryRun) {
    return {
      output: `[dry-run] Fast question prompt: "${prompt}"`,
      data: { prompt, dryRun: true },
    };
  }

  if (options.sendToDaemon) {
    // Send to tmux session pi-moe if running
    const tmuxCheck = spawnSync("tmux", ["has-session", "-t", "pi-moe"], { stdio: "ignore" });
    if (tmuxCheck.status === 0) {
      spawnSync("tmux", ["send-keys", "-t", "pi-moe", prompt, "C-m"]);
      return { output: `Dispatched question to running pi-moe tmux session: "${prompt}"` };
    }
  }

  // One-shot lightweight pi invocation
  const piArgs = [
    "-p",
    "--provider",
    "antigravity",
    "--model",
    "gemini-3.8-flash",
    "--thinking",
    "minimal",
    "--no-session",
    prompt,
  ];

  const res = spawnSync("pi", piArgs, { encoding: "utf8", timeout: 30000 });
  if (res.status === 0) {
    return { output: res.stdout.trim() };
  }

  return {
    output: res.stderr || res.stdout || "Fast question query failed",
    data: { exitCode: res.status },
  };
}

/**
 * Main execute entry point
 */
export async function executeCli(argv: string[]): Promise<CliExecutionResult> {
  const parsed = foldCliArgs(argv);
  const intent = classifyUtterance(parsed.utterance);

  // Override repo or role if provided as control flags
  if (parsed.project && !intent.repo) {
    intent.repo = parsed.project;
  }
  if (parsed.role && !intent.role) {
    intent.role = parsed.role;
  }

  let output = "";
  let data: unknown;

  if (intent.kind === "status") {
    output = handleStatus();
  } else if (intent.kind === "todo_ensure") {
    const res = handleTodoEnsure(intent.repo || parsed.project || "pi-moe", intent.taskTitle || parsed.utterance, parsed.dryRun);
    output = res.output;
    data = res.data;
  } else if (intent.kind === "memory_capture") {
    const res = handleMemoryCapture(intent.prompt || parsed.utterance, intent.targetMode || "memory", parsed.dryRun);
    output = res.output;
    data = res.data;
  } else if (intent.kind === "delegate") {
    if (parsed.dryRun) {
      output = `[dry-run] Delegate to role: ${intent.role}, task: "${intent.prompt}"`;
      data = { role: intent.role, task: intent.prompt };
    } else {
      const res = executeDispatch({
        role: (intent.role || "builder") as RoleName,
        task: intent.prompt || "",
        cwd: process.cwd(),
      });
      output = `Delegate dispatched: ${res.plan.id} (${res.receipt?.status ?? "running"})`;
      data = res;
    }
  } else {
    // fast_question
    const res = handleFastQuestion(intent.prompt || parsed.utterance, parsed);
    output = res.output;
    data = res.data;
  }

  return {
    intent,
    dryRun: parsed.dryRun,
    output,
    data,
  };
}
