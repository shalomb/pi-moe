import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadSkillRegister,
  saveSkillRegister,
  recordSkillFriction,
  getRegisterPath,
  type SkillRegister,
} from "../src/skills-register.ts";
import type { DispatchReceipt } from "../src/dispatch.ts";
import { validateMemoryNote } from "../src/xdg.ts";

describe("Skill Reliability Register & skill_friction Triage (src/skills-register.ts)", () => {
  let tmpDir: string;
  let tmpStateDir: string;
  let tmpRegisterPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-moe-skills-test-"));
    tmpStateDir = path.join(tmpDir, "state");
    tmpRegisterPath = path.join(tmpDir, "skill-register.json");

    // Seed test register
    const initialRegister: SkillRegister = {
      version: 1,
      skills: {
        "todo-navigator": {
          status: "verified",
          roles: ["moe", "builder", "planner"],
          deterministicEntrypoints: ["todo-nav", "todo"],
          lastVerified: "2026-10-24T00:00:00.000Z",
          frictionCount: 0,
        },
        "modern-cli-overrides": {
          status: "verified",
          roles: ["builder", "reviewer", "ops"],
          deterministicEntrypoints: ["rg", "fd"],
          lastVerified: "2026-10-24T00:00:00.000Z",
          frictionCount: 0,
        },
      },
    };
    fs.writeFileSync(tmpRegisterPath, JSON.stringify(initialRegister, null, 2), "utf8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads the packaged skill register correctly", () => {
    const reg = loadSkillRegister();
    assert.ok(reg.skills["todo-navigator"]);
    assert.ok(reg.skills["obsidian-notetaker"]);
    assert.ok(reg.skills["bart-adversarial-reviewer"]);
    assert.equal(reg.skills["todo-navigator"].status, "verified");
  });

  it("does nothing when receipt has no skillFriction", () => {
    const receipt: DispatchReceipt = {
      id: "builder-1",
      role: "builder",
      model: "test-model",
      cwd: "/test",
      task: "build something",
      status: "completed",
      exitCode: 0,
      durationMs: 120,
      summary: "success",
      skillFriction: [],
    };

    const res = recordSkillFriction(receipt, tmpRegisterPath, tmpStateDir);
    assert.equal(res.recorded, false);
    assert.equal(res.frictionItems.length, 0);

    const memoryFile = path.join(tmpStateDir, "memory", "skill-friction.md");
    assert.ok(!fs.existsSync(memoryFile), "Should not create memory file if no friction");
  });

  it("appends valid Tier-2 memory entry and marks skill as needs-script", () => {
    const receipt: DispatchReceipt = {
      id: "builder-test-receipt",
      role: "builder",
      model: "antigravity/gemini-3.8-flash",
      cwd: "/test",
      task: "implement feature X",
      status: "failed",
      exitCode: 1,
      durationMs: 500,
      summary: "Failed due to todo-navigator script error",
      skillFriction: [
        "todo-navigator failed to parse TODO.md due to unexpected format",
        "unknown-skill had syntax error",
      ],
    };

    const res = recordSkillFriction(receipt, tmpRegisterPath, tmpStateDir);
    assert.equal(res.recorded, true);
    assert.equal(res.frictionItems.length, 2);

    // Verify register updated
    const updated = loadSkillRegister(tmpRegisterPath);
    assert.equal(updated.skills["todo-navigator"].frictionCount, 1);
    assert.equal(updated.skills["todo-navigator"].status, "needs-script");
    assert.ok(updated.skills["unknown-skill"], "Should dynamically create entry for unknown skill");
    assert.equal(updated.skills["unknown-skill"].status, "needs-script");
    assert.equal(updated.skills["unknown-skill"].frictionCount, 1);

    // Verify memory/skill-friction.md created and valid Tier-2 memory note
    const memoryFile = path.join(tmpStateDir, "memory", "skill-friction.md");
    assert.ok(fs.existsSync(memoryFile), "skill-friction.md must exist");
    const content = fs.readFileSync(memoryFile, "utf8");

    const val = validateMemoryNote(content);
    assert.equal(val.valid, true, `skill-friction.md should be valid memory note: ${JSON.stringify(val.diagnostics)}`);
    assert.match(content, /tags:\s*\[.*skill-friction.*\]/);
    assert.match(content, /builder-test-receipt/);
    assert.match(content, /todo-navigator failed to parse/);

    // Second friction report should append and increment again
    const receipt2: DispatchReceipt = {
      ...receipt,
      id: "builder-receipt-2",
      skillFriction: ["todo-navigator timed out"],
    };
    recordSkillFriction(receipt2, tmpRegisterPath, tmpStateDir);

    const updated2 = loadSkillRegister(tmpRegisterPath);
    assert.equal(updated2.skills["todo-navigator"].frictionCount, 2);
    const content2 = fs.readFileSync(memoryFile, "utf8");
    assert.match(content2, /builder-receipt-2/);
    assert.match(content2, /todo-navigator timed out/);
  });
});
