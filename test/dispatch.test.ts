import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  buildDispatchPlan,
  executeDispatch,
  ROLE_DEFAULT_MODELS,
  ROLE_MEMORY_LIMITS,
  type RoleName,
} from "../src/dispatch.ts";

describe("Cgroup-Isolated Delegate Dispatcher (src/dispatch.ts)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-moe-dispatch-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("assigns appropriate default model and memory limit per role", () => {
    const roles: RoleName[] = ["moe", "librarian", "planner", "builder", "reviewer", "ops"];

    for (const role of roles) {
      const plan = buildDispatchPlan({
        role,
        task: "test task",
        env: { MOE_STATE_DIR: tmpDir },
      });

      assert.equal(plan.role, role);
      assert.equal(plan.model, ROLE_DEFAULT_MODELS[role].primary);
      assert.equal(plan.memoryLimit, ROLE_MEMORY_LIMITS[role]);
      assert.equal(plan.oomScoreAdjust, 500);
      assert.ok(plan.unitName.startsWith(`pi-moe-${role}-`));
      assert.equal(plan.env.PI_ROLE, role);
      assert.match(plan.env.TODO_OWNER, new RegExp(`^moe:${role}:`));
    }

    // Role-specific check: builder gets 4G, planner & reviewer get gemini-3.8-flash:medium
    const builderPlan = buildDispatchPlan({ role: "builder", task: "build it", env: { MOE_STATE_DIR: tmpDir } });
    assert.equal(builderPlan.memoryLimit, "4G");

    const plannerPlan = buildDispatchPlan({ role: "planner", task: "plan it", env: { MOE_STATE_DIR: tmpDir } });
    assert.equal(plannerPlan.model, "antigravity/gemini-3.8-flash:medium");

    const reviewerPlan = buildDispatchPlan({ role: "reviewer", task: "review it", env: { MOE_STATE_DIR: tmpDir } });
    assert.equal(reviewerPlan.model, "antigravity/gemini-3.8-flash:medium");
  });

  it("constructs systemd-run invocation with -pMemoryMax and -pOOMScoreAdjust when enabled", () => {
    const plan = buildDispatchPlan({
      role: "builder",
      task: "implement feature",
      forceSystemd: true,
      env: { MOE_STATE_DIR: tmpDir },
    });

    assert.equal(plan.useSystemd, true);
    assert.equal(plan.command, "systemd-run");
    assert.ok(plan.args.includes("--user"));
    assert.ok(plan.args.includes("--scope"));
    assert.ok(plan.args.some((a) => a.startsWith("-pMemoryMax=4G")));
    assert.ok(plan.args.some((a) => a.startsWith("-pOOMScoreAdjust=500")));
    assert.ok(plan.args.some((a) => a.startsWith(`--unit=${plan.unitName}`)));
  });

  it("supports dry-run without executing the command", () => {
    const res = executeDispatch({
      role: "builder",
      task: "implement test",
      dryRun: true,
      env: { MOE_STATE_DIR: tmpDir },
    });

    assert.ok(res.plan);
    assert.equal(res.receipt, undefined);
    assert.equal(fs.existsSync(res.plan.receiptPath), false);
  });

  it("executes command, captures exit status, and records structured receipt", () => {
    const res = executeDispatch({
      role: "ops",
      task: "run echo test",
      command: ["node", "-e", "console.log('task complete'); process.stdout.write('skill_friction: none')"],
      disableSystemd: true,
      env: { MOE_STATE_DIR: tmpDir },
    });

    assert.ok(res.receipt);
    assert.equal(res.receipt.status, "completed");
    assert.equal(res.receipt.exitCode, 0);
    assert.ok(res.receipt.durationMs >= 0);
    assert.ok(res.receipt.skillFriction.includes("none"));
    assert.ok(fs.existsSync(res.plan.receiptPath));

    const savedReceipt = JSON.parse(fs.readFileSync(res.plan.receiptPath, "utf8"));
    assert.equal(savedReceipt.id, res.receipt.id);
    assert.equal(savedReceipt.status, "completed");
  });

  it("detects exit code 137 as oom_killed", () => {
    const res = executeDispatch({
      role: "builder",
      task: "oom simulator",
      command: ["sh", "-c", "exit 137"],
      disableSystemd: true,
      env: { MOE_STATE_DIR: tmpDir },
    });

    assert.ok(res.receipt);
    assert.equal(res.receipt.status, "oom_killed");
    assert.equal(res.receipt.exitCode, 137);
    assert.match(res.receipt.summary, /kernel OOM killer/);
  });

  it("runs actual systemd-run --user --scope execution when systemd user bus is available", () => {
    const res = executeDispatch({
      role: "ops",
      task: "real systemd scope test",
      command: ["/bin/true"],
      disableSystemd: false,
      env: { MOE_STATE_DIR: tmpDir },
    });

    assert.ok(res.receipt);
    assert.equal(res.receipt.status, "completed");
    assert.equal(res.receipt.exitCode, 0);
    assert.ok(fs.existsSync(res.plan.receiptPath));
  });

  it("bin/moe-dispatch works end-to-end with --dry-run and --json", () => {
    const binDispatch = path.resolve("bin/moe-dispatch");

    const dryOut = execFileSync(
      binDispatch,
      ["--role=builder", "--task=build widget", "--dry-run", "--json"],
      {
        env: { ...process.env, MOE_STATE_DIR: tmpDir },
        encoding: "utf8",
      },
    );

    const dryParsed = JSON.parse(dryOut);
    assert.equal(dryParsed.role, "builder");
    assert.equal(dryParsed.memoryLimit, "4G");
    assert.equal(dryParsed.env.PI_ROLE, "builder");

    const execOut = execFileSync(
      binDispatch,
      [
        "--role=reviewer",
        "--task=review widget",
        "--cmd=node -e process.exit(0)",
        "--no-systemd",
        "--json",
      ],
      {
        env: { ...process.env, MOE_STATE_DIR: tmpDir },
        encoding: "utf8",
      },
    );

    const execParsed = JSON.parse(execOut);
    assert.equal(execParsed.role, "reviewer");
    assert.equal(execParsed.status, "completed");
    assert.equal(execParsed.exitCode, 0);
  });
});
