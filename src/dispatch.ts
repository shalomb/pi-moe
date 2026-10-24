import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveStateDir } from "./xdg.ts";

export type RoleName = "moe" | "librarian" | "planner" | "builder" | "reviewer" | "ops";

export interface RoleModelConfig {
  primary: string;
  fallback: string;
}

export const ROLE_DEFAULT_MODELS: Record<RoleName, RoleModelConfig> = {
  moe: {
    primary: "antigravity/gemini-3.8-flash:minimal",
    fallback: "anthropic/claude-sonnet-5-5:low",
  },
  librarian: {
    primary: "antigravity/gemini-3.8-flash:low",
    fallback: "anthropic/claude-sonnet-5-5:low",
  },
  planner: {
    primary: "antigravity/gemini-3.8-flash:medium",
    fallback: "anthropic/claude-sonnet-5-5:low",
  },
  builder: {
    primary: "antigravity/gemini-3.8-flash:low",
    fallback: "anthropic/claude-sonnet-5-5:low",
  },
  reviewer: {
    primary: "antigravity/gemini-3.8-flash:medium",
    fallback: "anthropic/claude-sonnet-5-5:low",
  },
  ops: {
    primary: "antigravity/gemini-3.8-flash:minimal",
    fallback: "anthropic/claude-sonnet-5-5:low",
  },
};

export const ROLE_MEMORY_LIMITS: Record<RoleName, string> = {
  moe: "1G",
  librarian: "2G",
  planner: "2G",
  builder: "4G",
  reviewer: "2G",
  ops: "2G",
};

export interface DispatchReceipt {
  id: string;
  role: RoleName;
  model: string;
  cwd: string;
  task: string;
  status: "completed" | "oom_killed" | "failed";
  exitCode: number;
  durationMs: number;
  summary: string;
  skillFriction: string[];
}

export interface DispatchPlan {
  id: string;
  role: RoleName;
  model: string;
  memoryLimit: string;
  oomScoreAdjust: number;
  unitName: string;
  useSystemd: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  receiptPath: string;
}

export interface DispatchOptions {
  id?: string;
  role: RoleName;
  task: string;
  command?: string[];
  cwd?: string;
  model?: string;
  memoryLimit?: string;
  oomScoreAdjust?: number;
  stateDir?: string;
  env?: Record<string, string>;
  dryRun?: boolean;
  forceSystemd?: boolean;
  disableSystemd?: boolean;
}

export function generateDispatchId(role: RoleName): string {
  const timestamp = Date.now().toString(36);
  const randomSuffix = Math.random().toString(36).substring(2, 6);
  return `${role}-${timestamp}-${randomSuffix}`;
}

export function isSystemdRunAvailable(): boolean {
  try {
    const res = spawnSync("systemd-run", ["--user", "--scope", "-pMemoryMax=1G", "/bin/true"], {
      stdio: "ignore",
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

export function buildDispatchPlan(options: DispatchOptions): DispatchPlan {
  const role = options.role;
  const id = options.id || generateDispatchId(role);
  const modelConfig = ROLE_DEFAULT_MODELS[role] || {
    primary: "antigravity/gemini-3.8-flash:low",
    fallback: "anthropic/claude-sonnet-5-5:low",
  };
  const model = options.model || modelConfig.primary;
  const memoryLimit = options.memoryLimit || ROLE_MEMORY_LIMITS[role] || "2G";
  const oomScoreAdjust = options.oomScoreAdjust !== undefined ? options.oomScoreAdjust : 500;
  const unitName = `pi-moe-${role}-${id}`;

  const stateDir = resolveStateDir(options.env || process.env);
  const receiptsDir = path.join(stateDir, "receipts");
  const receiptPath = path.join(receiptsDir, `${id}.json`);

  let useSystemd = false;
  if (options.disableSystemd) {
    useSystemd = false;
  } else if (options.forceSystemd) {
    useSystemd = true;
  } else {
    useSystemd = isSystemdRunAvailable();
  }

  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(options.env || {}),
    PI_ROLE: role,
    TODO_OWNER: `moe:${role}:${id}`,
    MOE_STATE_DIR: stateDir,
  };

  const workerCmd = (options.command && options.command.length > 0)
    ? options.command
    : ["pi", "--mode", "json", options.task];

  let execCommand = workerCmd[0];
  let execArgs = workerCmd.slice(1);

  if (useSystemd) {
    execCommand = "systemd-run";
    execArgs = [
      "--user",
      "--scope",
      `-pMemoryMax=${memoryLimit}`,
      "-pOOMScoreAdjust=500",
      `--unit=${unitName}`,
      ...workerCmd,
    ];
  }

  return {
    id,
    role,
    model,
    memoryLimit,
    oomScoreAdjust,
    unitName,
    useSystemd,
    command: execCommand,
    args: execArgs,
    env: baseEnv,
    receiptPath,
  };
}

export function executeDispatch(options: DispatchOptions): {
  plan: DispatchPlan;
  receipt?: DispatchReceipt;
  stdout?: string;
  stderr?: string;
} {
  const plan = buildDispatchPlan(options);

  if (options.dryRun) {
    return { plan };
  }

  const startTime = Date.now();
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  const spawnRes = spawnSync(plan.command, plan.args, {
    cwd,
    env: plan.env,
    encoding: "utf8",
  });

  // If systemd-run failed because systemd refused a property (e.g. OOMScoreAdjust on scope units in some systemd versions),
  // fallback gracefully to direct execution without systemd.
  let activeSpawnRes = spawnRes;
  if (
    plan.useSystemd &&
    spawnRes.status !== 0 &&
    spawnRes.stderr &&
    (spawnRes.stderr.includes("Unknown assignment: OOMScoreAdjust") ||
      spawnRes.stderr.includes("Failed to start transient"))
  ) {
    const directCmd = (options.command && options.command.length > 0)
      ? options.command
      : ["pi", "--mode", "json", options.task];
    activeSpawnRes = spawnSync(directCmd[0], directCmd.slice(1), {
      cwd,
      env: plan.env,
      encoding: "utf8",
    });
  }

  const durationMs = Date.now() - startTime;
  const exitCode = activeSpawnRes.status !== null ? activeSpawnRes.status : 1;
  const isOom = exitCode === 137;

  let status: "completed" | "oom_killed" | "failed" = "completed";
  if (isOom) {
    status = "oom_killed";
  } else if (exitCode !== 0) {
    status = "failed";
  }

  let summary = `Worker exited with status ${status} (code ${exitCode})`;
  if (status === "completed") {
    summary = `Worker task completed successfully in ${durationMs}ms`;
  } else if (status === "oom_killed") {
    summary = `Worker was terminated by kernel OOM killer (exit 137) with MemoryMax=${plan.memoryLimit}`;
  }

  // Scan output for skill_friction notices
  const skillFriction: string[] = [];
  const outputCombined = (spawnRes.stdout || "") + "\n" + (spawnRes.stderr || "");
  const frictionMatches = outputCombined.matchAll(/skill_friction:\s*([^\n\r]+)/gi);
  for (const m of frictionMatches) {
    if (m[1] && m[1].trim()) {
      skillFriction.push(m[1].trim());
    }
  }

  const receipt: DispatchReceipt = {
    id: plan.id,
    role: plan.role,
    model: plan.model,
    cwd,
    task: options.task,
    status,
    exitCode,
    durationMs,
    summary,
    skillFriction,
  };

  // Write structured receipt to disk
  try {
    fs.mkdirSync(path.dirname(plan.receiptPath), { recursive: true });
    fs.writeFileSync(plan.receiptPath, JSON.stringify(receipt, null, 2), "utf8");
  } catch (err) {
    console.error(`Warning: Failed to write receipt to ${plan.receiptPath}:`, err);
  }

  return {
    plan,
    receipt,
    stdout: spawnRes.stdout,
    stderr: spawnRes.stderr,
  };
}
