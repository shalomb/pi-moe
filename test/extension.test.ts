import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  renderFocusSection,
  buildCompactionGroomingInstructions,
  updateActiveFocus,
} from "../src/groom.ts";
import { bootstrapXdgState, validateFocus, estimateTokens } from "../src/xdg.ts";
import extension from "../src/extension.ts";

describe("Memory Grooming & pi-moe Extension (src/groom.ts & src/extension.ts)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-moe-groom-test-"));
    bootstrapXdgState({ stateDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Grooming logic (src/groom.ts)", () => {
    it("renderFocusSection returns <moe_focus> block within 1000-token budget", () => {
      const section = renderFocusSection(tmpDir);
      assert.ok(section.startsWith("<moe_focus>"));
      assert.ok(section.endsWith("</moe_focus>"));
      assert.match(section, /## Active Focus/);
      assert.match(section, /## Standing Anchors/);
      assert.ok(estimateTokens(section) <= 1000);
    });

    it("renderFocusSection truncates oversized focus.md and includes warning", () => {
      const focusPath = path.join(tmpDir, "focus.md");
      const bloated = [
        "---",
        "id: focus",
        "updated: 2026-10-24T00:00:00Z",
        "max_tokens: 1000",
        "---",
        "## Active Focus",
        "Long line: " + "a".repeat(4500),
        "## Running Delegates",
        "(none)",
        "## Standing Anchors",
        "- Anchor 1",
      ].join("\n");
      fs.writeFileSync(focusPath, bloated, "utf8");

      const section = renderFocusSection(tmpDir);
      assert.ok(section.includes("[WARNING: focus.md exceeded 1000 tokens and was truncated]"));
      assert.ok(estimateTokens(section) <= 1000);
    });

    it("buildCompactionGroomingInstructions returns instructions preserving semantic anchors and discarding noise", () => {
      const instructions = buildCompactionGroomingInstructions("Focus on Wave 2");
      assert.match(instructions, /semantic anchors/i);
      assert.match(instructions, /discard.*tool noise/i);
      assert.match(instructions, /Focus on Wave 2/);
    });

    it("updateActiveFocus updates focus sections, deduplicates lines, and stays within budget", () => {
      const updated = updateActiveFocus(tmpDir, {
        activeFocus: ["Task A in progress", "Task A in progress", "Task B queued"],
        runningDelegates: ["builder: test-1", "builder: test-1"],
        standingAnchors: ["TDD & Farley index", "Security audit"],
      });

      assert.equal(updated.validation.valid, true);
      assert.ok(updated.tokenCount <= 1000);

      const content = fs.readFileSync(path.join(tmpDir, "focus.md"), "utf8");
      // Check deduplication
      const matchesTaskA = content.match(/Task A in progress/g);
      assert.equal(matchesTaskA?.length, 1);

      const matchesBuilder = content.match(/builder: test-1/g);
      assert.equal(matchesBuilder?.length, 1);
    });
  });

  describe("Extension registration and hooks (src/extension.ts)", () => {
    it("registers before_agent_start hook that injects moe_focus when PI_ROLE=moe or MOE_ENABLED=1", async () => {
      const handlers: Record<string, Function[]> = {};
      const registeredCommands: Record<string, any> = {};
      const registeredTools: Record<string, any> = {};

      const mockPi: any = {
        on: (event: string, handler: Function) => {
          handlers[event] = handlers[event] || [];
          handlers[event].push(handler);
        },
        registerCommand: (name: string, def: any) => {
          registeredCommands[name] = def;
        },
        registerTool: (tool: any) => {
          registeredTools[tool.name] = tool;
        },
      };

      extension(mockPi);

      // Verify command and tools registered
      assert.ok(registeredCommands["moe"]);
      assert.ok(registeredTools["moe_delegate"]);
      assert.ok(registeredTools["moe_memory"]);

      // Verify hook injection with PI_ROLE=moe
      const origEnv = { ...process.env };
      try {
        process.env.PI_ROLE = "moe";
        process.env.MOE_STATE_DIR = tmpDir;

        const event: any = { systemPromptOptions: { sections: {} } };
        assert.ok(handlers["before_agent_start"]?.length > 0);
        await handlers["before_agent_start"][0](event);

        assert.ok(event.systemPromptOptions.sections.moe_focus);
        assert.match(event.systemPromptOptions.sections.moe_focus, /<moe_focus>/);

        // Verify session_before_compact hook attaches grooming instructions
        assert.ok(handlers["session_before_compact"]?.length > 0);
        const compactEvent: any = { customInstructions: "Custom note" };
        await handlers["session_before_compact"][0](compactEvent);
        assert.match(compactEvent.customInstructions, /semantic anchors/i);
        assert.match(compactEvent.customInstructions, /Custom note/);
      } finally {
        process.env = origEnv;
      }
    });

    it("moe_delegate tool executes dispatch and updates focus.md", async () => {
      const registeredTools: Record<string, any> = {};
      const mockPi: any = {
        on: () => {},
        registerCommand: () => {},
        registerTool: (tool: any) => {
          registeredTools[tool.name] = tool;
        },
      };

      extension(mockPi);
      const delegateTool = registeredTools["moe_delegate"];
      assert.ok(delegateTool);

      const origEnv = { ...process.env };
      try {
        process.env.MOE_STATE_DIR = tmpDir;

        const res = await delegateTool.execute(
          "call-1",
          {
            role: "builder",
            task: "run quick test",
            command: ["node", "-e", "console.log('delegate-finished'); console.log('skill_friction: test-skill failed to parse');"],
            disableSystemd: true,
          },
          new AbortController().signal,
          () => {},
          { cwd: tmpDir },
        );

        assert.equal(res.details.receipt.status, "completed");
        assert.ok(res.content[0].text.includes("completed"));

        // Verify friction was triaged
        const memFile = path.join(tmpDir, "memory", "skill-friction.md");
        assert.ok(fs.existsSync(memFile));

        // Verify focus.md running delegates updated
        const focusContent = fs.readFileSync(path.join(tmpDir, "focus.md"), "utf8");
        assert.match(focusContent, /builder:/);
      } finally {
        process.env = origEnv;
      }
    });
  });
});
