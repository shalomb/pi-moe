import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  foldCliArgs,
  classifyUtterance,
  resolveProjectRepo,
  executeCli,
} from "../src/cli.ts";

describe("Quote-Free DWIM moe CLI (src/cli.ts)", () => {
  describe("foldCliArgs", () => {
    it("strips leading separator and folds non-flag words into utterance", () => {
      const res = foldCliArgs(["-", "can", "you", "ensure", "we", "have", "a", "task", "down", "for", "project", "ob-cli", "to", "support", "tags"]);
      assert.equal(res.utterance, "can you ensure we have a task down for project ob-cli to support tags");
      assert.equal(res.dryRun, false);
      assert.equal(res.json, false);
    });

    it("parses control flags while folding the rest", () => {
      const res = foldCliArgs(["--dry-run", "--debug", "--json", "I", "have", "a", "question", "about", "systemd", "scopes"]);
      assert.equal(res.dryRun, true);
      assert.equal(res.debug, true);
      assert.equal(res.json, true);
      assert.equal(res.utterance, "I have a question about systemd scopes");
    });

    it("handles role and project flags", () => {
      const res = foldCliArgs(["--role", "builder", "--project", "pi-moe", "--", "inspect", "logs"]);
      assert.equal(res.role, "builder");
      assert.equal(res.project, "pi-moe");
      assert.equal(res.utterance, "inspect logs");
    });

    it("handles empty args as empty utterance", () => {
      const res = foldCliArgs([]);
      assert.equal(res.utterance, "");
    });
  });

  describe("classifyUtterance", () => {
    it("classifies empty utterance or status/focus as status intent", () => {
      assert.equal(classifyUtterance("").kind, "status");
      assert.equal(classifyUtterance("status").kind, "status");
      assert.equal(classifyUtterance("focus").kind, "status");
    });

    it("classifies attach / tui / console as attach intent", () => {
      assert.equal(classifyUtterance("attach").kind, "attach");
      assert.equal(classifyUtterance("tui").kind, "attach");
      assert.equal(classifyUtterance("console").kind, "attach");
    });

    it("classifies todo ensure patterns", () => {
      const c1 = classifyUtterance("can you ensure we have a task down for project ob-cli to support tags");
      assert.equal(c1.kind, "todo_ensure");
      assert.equal(c1.repo, "ob-cli");
      assert.equal(c1.taskTitle, "support tags");

      const c2 = classifyUtterance("todo pi-moe: add metrics to dispatch");
      assert.equal(c2.kind, "todo_ensure");
      assert.equal(c2.repo, "pi-moe");
      assert.equal(c2.taskTitle, "add metrics to dispatch");

      const c3 = classifyUtterance("can you ensure we have a task down for project pi-moe for add metrics");
      assert.equal(c3.kind, "todo_ensure");
      assert.equal(c3.repo, "pi-moe");
      assert.equal(c3.taskTitle, "add metrics");
    });

    it("classifies memory notes / remember / jot down", () => {
      const c1 = classifyUtterance("note: remember to test tailscale funnel on idun");
      assert.equal(c1.kind, "memory_capture");
      assert.equal(c1.targetMode, "memory");
      assert.equal(c1.prompt, "remember to test tailscale funnel on idun");

      const c2 = classifyUtterance("remember vault note: update obsidian index");
      assert.equal(c2.kind, "memory_capture");
      assert.equal(c2.targetMode, "obsidian");
      assert.equal(c2.prompt, "update obsidian index");

      const c3 = classifyUtterance("jot down check server temperature");
      assert.equal(c3.kind, "memory_capture");
      assert.equal(c3.targetMode, "memory");
      assert.equal(c3.prompt, "check server temperature");
    });

    it("classifies delegate patterns", () => {
      const c = classifyUtterance("delegate to builder check build status");
      assert.equal(c.kind, "delegate");
      assert.equal(c.role, "builder");
      assert.equal(c.prompt, "check build status");
    });

    it("classifies workstation gum repo count questions as gum_query", () => {
      const c = classifyUtterance("how many repos does gum have?");
      assert.equal(c.kind, "gum_query");
    });

    it("classifies general questions or instructions as fast_question", () => {
      const c = classifyUtterance("I have a question about systemd scopes");
      assert.equal(c.kind, "fast_question");
      assert.equal(c.prompt, "I have a question about systemd scopes");
    });
  });

  describe("resolveProjectRepo", () => {
    it("resolves local sibling repos or matches by name", () => {
      const res = resolveProjectRepo("pi-moe");
      assert.ok(res);
      assert.match(res, /pi-moe$/);
    });
  });

  describe("executeCli end-to-end dry-run", () => {
    it("handles dry-run for attach", async () => {
      const out = await executeCli(["--dry-run", "attach"]);
      assert.equal(out.intent.kind, "attach");
      assert.match(out.output, /tmux attach-session -t pi-moe/);
    });

    it("handles dry-run for fast_question", async () => {
      const out = await executeCli(["--dry-run", "I", "have", "a", "question", "about", "systemd", "scopes"]);
      assert.equal(out.intent.kind, "fast_question");
      assert.equal(out.dryRun, true);
    });

    it("handles dry-run for todo_ensure", async () => {
      const out = await executeCli(["--dry-run", "-", "can", "you", "ensure", "we", "have", "a", "task", "down", "for", "project", "pi-moe", "to", "add", "metrics"]);
      assert.equal(out.intent.kind, "todo_ensure");
      assert.equal(out.intent.repo, "pi-moe");
      assert.equal(out.intent.taskTitle, "add metrics");
      assert.equal(out.dryRun, true);
    });

    it("handles status immediately", async () => {
      const out = await executeCli(["status"]);
      assert.equal(out.intent.kind, "status");
      assert.ok(out.output.includes("Focus:"));
    });
  });

  describe("Behavioral side-effect execution (isolated temp env, no --dry-run)", () => {
    it("executes memory_capture against isolated MOE_STATE_DIR and ob-cli --json retrieves the captured note", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const { execFileSync } = await import("node:child_process");

      const tmpState = fs.mkdtempSync(path.join(os.tmpdir(), "pi-moe-cli-mem-"));
      try {
        const out = await executeCli(
          ["note:", "verify", "farley", "behavioral", "capture"],
          { env: { ...process.env, MOE_STATE_DIR: tmpState } },
        );
        assert.equal(out.intent.kind, "memory_capture");
        assert.equal(out.dryRun, false);

        const memDir = path.join(tmpState, "memory");
        const jsonOut = execFileSync("ob-cli", ["--dir", memDir, "--tag", "inbox", "--json"], {
          encoding: "utf8",
        });
        const notes = JSON.parse(jsonOut);
        assert.equal(notes.length, 1);
        assert.equal(notes[0].path, "inbox.md");

        const catOut = execFileSync("ob-cli", ["--dir", memDir, "--cat", "inbox.md"], {
          encoding: "utf8",
        });
        assert.match(catOut, /verify farley behavioral capture/);
      } finally {
        fs.rmSync(tmpState, { recursive: true, force: true });
      }
    });

    it("executes todo_ensure idempotently against an isolated repo (creates once, skips duplicate on second run)", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");

      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-moe-cli-todo-"));
      const tmpRepo = path.join(tmpRoot, "sample-repo");
      const tmpCache = path.join(tmpRoot, "cache");
      fs.mkdirSync(tmpRepo, { recursive: true });
      fs.mkdirSync(tmpCache, { recursive: true });

      try {
        const env = { ...process.env, XDG_CACHE_HOME: tmpCache };
        const first = await executeCli(
          ["--project", tmpRepo, "-", "can", "you", "ensure", "we", "have", "a", "task", "down", "for", "project", tmpRepo, "to", "wire", "up", "healthcheck"],
          { env },
        );
        assert.equal(first.intent.kind, "todo_ensure");
        assert.equal((first.data as any)?.created, true);

        const second = await executeCli(
          ["--project", tmpRepo, "-", "can", "you", "ensure", "we", "have", "a", "task", "down", "for", "project", tmpRepo, "to", "wire", "up", "healthcheck"],
          { env },
        );
        assert.equal(second.intent.kind, "todo_ensure");
        assert.equal((second.data as any)?.exists, true);
        assert.match(second.output, /already exists/i);
      } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  });
});
