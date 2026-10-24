import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  resolveStateDir,
  getStatePaths,
  bootstrapXdgState,
  validateFocus,
  validateMemoryNote,
  estimateTokens,
} from "../src/xdg.ts";

describe("XDG State Layout & Validation (src/xdg.ts)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-moe-xdg-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves MOE_STATE_DIR with highest priority, then XDG_STATE_HOME, then ~/.local/state/pi-moe", () => {
    assert.equal(
      resolveStateDir({
        MOE_STATE_DIR: "/custom/moe-state",
        XDG_STATE_HOME: "/custom/xdg",
        HOME: "/home/tester",
      }),
      "/custom/moe-state",
    );

    assert.equal(
      resolveStateDir({
        XDG_STATE_HOME: "/custom/xdg",
        HOME: "/home/tester",
      }),
      "/custom/xdg/pi-moe",
    );

    assert.equal(
      resolveStateDir({
        HOME: "/home/tester",
      }),
      "/home/tester/.local/state/pi-moe",
    );
  });

  it("bootstraps focus.md, memory/, and receipts/ idempotently", () => {
    const first = bootstrapXdgState({
      stateDir: tmpDir,
      now: "2026-10-24T20:30:00Z",
    });

    assert.equal(first.createdFocus, true);
    assert.equal(first.validation.valid, true);
    assert.ok(fs.existsSync(first.focusPath), "focus.md should exist");
    assert.ok(fs.statSync(first.memoryDir).isDirectory(), "memory/ should be a directory");
    assert.ok(fs.statSync(first.receiptsDir).isDirectory(), "receipts/ should be a directory");

    const content = fs.readFileSync(first.focusPath, "utf8");
    assert.match(content, /id:\s*focus/);
    assert.match(content, /updated:\s*2026-10-24T20:30:00Z/);
    assert.match(content, /max_tokens:\s*1000/);
    assert.match(content, /## Active Focus/);
    assert.match(content, /## Running Delegates/);
    assert.match(content, /## Standing Anchors/);

    // Modify focus.md and verify second bootstrap does not overwrite it
    const customContent = content + "\n- Custom mission anchor\n";
    fs.writeFileSync(first.focusPath, customContent, "utf8");

    const second = bootstrapXdgState({
      stateDir: tmpDir,
      now: "2026-10-25T00:00:00Z",
    });

    assert.equal(second.createdFocus, false);
    assert.equal(fs.readFileSync(second.focusPath, "utf8"), customContent);
  });

  it("enforces the 1000-token budget (Math.ceil(content.length / 4) <= 1000) on focus.md", () => {
    const { focusPath } = bootstrapXdgState({ stateDir: tmpDir });
    const baseContent = fs.readFileSync(focusPath, "utf8");

    const validRes = validateFocus(baseContent);
    assert.equal(validRes.valid, true);
    assert.equal(validRes.tokenCount, estimateTokens(baseContent));
    assert.ok(validRes.tokenCount <= 1000);

    // Overflow content beyond 4000 characters (> 1000 tokens)
    const bloatedContent = baseContent + "\n" + "x".repeat(4004);
    assert.ok(Math.ceil(bloatedContent.length / 4) > 1000);

    const overflowRes = validateFocus(bloatedContent);
    assert.equal(overflowRes.valid, false);
    assert.ok(
      overflowRes.diagnostics.some((d) => d.code === "TOKEN_BUDGET_EXCEEDED"),
      "Expected TOKEN_BUDGET_EXCEEDED diagnostic",
    );
  });

  it("rejects focus.md with missing frontmatter fields or missing required sections", () => {
    const missingSection = [
      "---",
      "id: focus",
      "updated: 2026-10-24T20:30:00Z",
      "max_tokens: 1000",
      "---",
      "## Active Focus",
      "- Working on task",
      "## Standing Anchors",
      "- TDD",
    ].join("\n");

    const res = validateFocus(missingSection);
    assert.equal(res.valid, false);
    assert.ok(
      res.diagnostics.some(
        (d) => d.code === "MISSING_SECTION" && d.message.includes("## Running Delegates"),
      ),
    );

    const wrongId = [
      "---",
      "id: wrong-id",
      "updated: 2026-10-24T20:30:00Z",
      "max_tokens: 1000",
      "---",
      "## Active Focus",
      "## Running Delegates",
      "## Standing Anchors",
    ].join("\n");

    const wrongIdRes = validateFocus(wrongId);
    assert.equal(wrongIdRes.valid, false);
    assert.ok(wrongIdRes.diagnostics.some((d) => d.field === "id"));
  });

  it("validates Tier 2 memory notes (id, tags, created/modified)", () => {
    const validInlineTags = [
      "---",
      "id: workstation-quirks",
      "tags: [idun, systemd, memory]",
      "created: 2026-10-24T20:30:00Z",
      "modified: 2026-10-24T20:35:00Z",
      "---",
      "# Workstation Quirks",
      "Notes about cgroup scopes.",
    ].join("\n");

    const res1 = validateMemoryNote(validInlineTags);
    assert.equal(res1.valid, true);
    assert.equal(res1.diagnostics.length, 0);

    const validBlockTags = [
      "---",
      "id: session-handoff-01",
      "tags:",
      "  - handoff",
      "  - pi-moe",
      "modified: 2026-10-24T21:00:00Z",
      "---",
      "Handoff body.",
    ].join("\n");

    const res2 = validateMemoryNote(validBlockTags);
    assert.equal(res2.valid, true);

    const invalidNote = [
      "---",
      "id: missing-tags-and-dates",
      "---",
      "Body without tags or timestamps.",
    ].join("\n");

    const res3 = validateMemoryNote(invalidNote);
    assert.equal(res3.valid, false);
    assert.ok(res3.diagnostics.some((d) => d.field === "tags"));
    assert.ok(res3.diagnostics.some((d) => d.field === "created"));
  });

  it("CLI bin/moe-init bootstraps state dir and bin/moe-memory validates focus.md", () => {
    const cliDir = path.join(tmpDir, "cli-state");
    const binInit = path.resolve("bin/moe-init");
    const binMemory = path.resolve("bin/moe-memory");

    const out = execFileSync(binInit, ["--json"], {
      env: { ...process.env, MOE_STATE_DIR: cliDir },
      encoding: "utf8",
    });

    const parsed = JSON.parse(out);
    assert.equal(parsed.stateDir, cliDir);
    assert.equal(parsed.validation.valid, true);
    assert.ok(fs.existsSync(path.join(cliDir, "focus.md")));

    const validateOut = execFileSync(
      binMemory,
      ["validate-focus", "--json"],
      {
        env: { ...process.env, MOE_STATE_DIR: cliDir },
        encoding: "utf8",
      },
    );
    const validateParsed = JSON.parse(validateOut);
    assert.equal(validateParsed.valid, true);
  });
});
