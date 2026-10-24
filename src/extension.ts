import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildCompactionGroomingInstructions,
  renderFocusSection,
  updateActiveFocus,
} from "./groom.ts";
import { executeDispatch, type RoleName } from "./dispatch.ts";
import { recordSkillFriction } from "./skills-register.ts";
import { resolveStateDir, getStatePaths } from "./xdg.ts";
import { MOE_HIGH_AGENCY_CHARTER } from "./charter.ts";

export interface ExtensionAPI {
  on(event: string, handler: (event: any, ctx?: any) => Promise<any> | any): void;
  registerCommand(name: string, def: { description: string; handler: (args: string, ctx: any) => Promise<any> | any }): void;
  registerTool(def: any): void;
  exec?(command: string, args: string[]): Promise<any>;
  sendMessage?(message: any, options?: any): void;
}

export default function moeExtension(pi: ExtensionAPI) {
  // 1. Hook before_agent_start: Inject moe_focus and moe_charter into systemPromptOptions.sections
  pi.on("before_agent_start", async (event: any) => {
    const isMoe = process.env.PI_ROLE === "moe" || process.env.MOE_ENABLED === "1";
    if (!isMoe) return;

    const stateDir = resolveStateDir();
    const focusSection = renderFocusSection(stateDir);

    if (event?.systemPromptOptions) {
      if (!event.systemPromptOptions.sections) {
        event.systemPromptOptions.sections = {};
      }
      event.systemPromptOptions.sections.moe_focus = focusSection;
      event.systemPromptOptions.sections.moe_charter = MOE_HIGH_AGENCY_CHARTER;
    }
  });

  // 2. Hook session_before_compact: Memory grooming directives
  pi.on("session_before_compact", async (event: any) => {
    const isMoe = process.env.PI_ROLE === "moe" || process.env.MOE_ENABLED === "1";
    if (!isMoe) return;

    const existingInstructions = event.customInstructions || "";
    event.customInstructions = buildCompactionGroomingInstructions(existingInstructions);
  });

  // 3. Register /moe slash command
  pi.registerCommand("moe", {
    description: "Manage Moe orchestrator: status, focus, dispatch, groom, friction",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = parts[0] || "status";
      const stateDir = resolveStateDir();
      const paths = getStatePaths(stateDir);

      if (sub === "status") {
        const role = process.env.PI_ROLE || "default";
        const focusExists = fs.existsSync(paths.focusPath);
        const receiptCount = fs.existsSync(paths.receiptsDir)
          ? fs.readdirSync(paths.receiptsDir).length
          : 0;
        const msg = `Moe Orchestrator Status:
- Role: ${role}
- State Dir: ${paths.stateDir}
- focus.md: ${focusExists ? "Present" : "Missing"}
- Receipts logged: ${receiptCount}`;
        if (ctx?.ui?.notify) ctx.ui.notify(msg, "info");
        return msg;
      }

      if (sub === "focus") {
        if (!fs.existsSync(paths.focusPath)) {
          if (ctx?.ui?.notify) ctx.ui.notify("focus.md not found", "error");
          return "focus.md not found";
        }
        const content = fs.readFileSync(paths.focusPath, "utf8");
        if (ctx?.ui?.notify) ctx.ui.notify(content, "info");
        return content;
      }

      if (sub === "groom") {
        const res = updateActiveFocus(stateDir, {});
        const msg = `focus.md groomed (${res.tokenCount} tokens)`;
        if (ctx?.ui?.notify) ctx.ui.notify(msg, "info");
        return msg;
      }

      if (sub === "friction") {
        const memFriction = path.join(paths.memoryDir, "skill-friction.md");
        if (!fs.existsSync(memFriction)) {
          const msg = "No skill friction recorded yet.";
          if (ctx?.ui?.notify) ctx.ui.notify(msg, "info");
          return msg;
        }
        const content = fs.readFileSync(memFriction, "utf8");
        if (ctx?.ui?.notify) ctx.ui.notify(content, "info");
        return content;
      }

      if (sub === "dispatch") {
        const roleArg = (parts[1] || "builder") as RoleName;
        const taskArg = parts.slice(2).join(" ") || "inspect project status";
        const result = executeDispatch({
          role: roleArg,
          task: taskArg,
          cwd: ctx?.cwd || process.cwd(),
          stateDir,
        });
        if (result.receipt) {
          recordSkillFriction(result.receipt, undefined, stateDir);
        }
        const msg = `Dispatched to ${roleArg} (id: ${result.plan.id}). Status: ${result.receipt?.status ?? "unknown"}`;
        if (ctx?.ui?.notify) ctx.ui.notify(msg, "info");
        return msg;
      }

      return `Unknown subcommand: ${sub}. Supported: status, focus, dispatch, groom, friction`;
    },
  });

  // 4. Register DWIM tools for Moe
  pi.registerTool({
    name: "moe_delegate",
    label: "Moe Delegate Dispatcher",
    description:
      "Dispatch a focused specialist task to one of the 5 expert roles (librarian, planner, builder, reviewer, ops) with memory isolation and receipt logging.",
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["librarian", "planner", "builder", "reviewer", "ops"],
          description: "Specialist role for this task",
        },
        task: {
          type: "string",
          description: "Task description or instruction for the specialist",
        },
        command: {
          type: "array",
          items: { type: "string" },
          description: "Optional custom command to run instead of default pi worker",
        },
        disableSystemd: {
          type: "boolean",
          description: "Disable systemd-run wrapper if running in constrained environments",
        },
      },
      required: ["role", "task"],
    },
    async execute(_id: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const stateDir = resolveStateDir();
      const role = params.role as RoleName;
      const task = params.task;
      const cwd = ctx?.cwd || process.cwd();

      const result = executeDispatch({
        role,
        task,
        command: params.command,
        disableSystemd: params.disableSystemd,
        cwd,
        stateDir,
      });

      if (result.receipt) {
        // Record skill friction
        recordSkillFriction(result.receipt, undefined, stateDir);

        // Update focus.md running delegates section
        updateActiveFocus(stateDir, {
          runningDelegates: [`${role}: ${result.plan.id} (${result.receipt.status}) - ${task}`],
        });
      }

      const receipt = result.receipt;
      const textOutput = `Worker [${role}] ${receipt ? receipt.status : "finished"}:\n${receipt?.summary || ""}\n\nStdout:\n${result.stdout || ""}\nStderr:\n${result.stderr || ""}`.trim();

      return {
        content: [{ type: "text", text: textOutput }],
        details: {
          plan: result.plan,
          receipt: result.receipt,
        },
      };
    },
  });

  pi.registerTool({
    name: "moe_memory",
    label: "Moe Memory & Obsidian Access",
    description:
      "Deterministic wrapper around ob-cli --mode=memory|obsidian (query, capture, cat, focus_update) for durable second-brain memory access.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["query", "capture", "cat", "focus_update"],
          description: "Action to perform: query, capture, cat, or focus_update",
        },
        query: {
          type: "string",
          description: "Search term or tag query",
        },
        tag: {
          type: "string",
          description: "Tag filter for queries",
        },
        title: {
          type: "string",
          description: "Note title for capture",
        },
        tags: {
          type: "string",
          description: "Comma-separated tags for capture",
        },
        content: {
          type: "string",
          description: "Body content to capture or new focus line",
        },
        file: {
          type: "string",
          description: "File to read for cat action",
        },
      },
      required: ["action"],
    },
    async execute(_id: string, params: any) {
      const stateDir = resolveStateDir();

      if (params.action === "focus_update") {
        if (!params.content) {
          return {
            content: [{ type: "text", text: "Error: focus_update requires content string" }],
            details: { error: "missing_content" },
          };
        }
        const updated = updateActiveFocus(stateDir, {
          activeFocus: [params.content],
        });
        return {
          content: [
            {
              type: "text",
              text: `Updated focus.md successfully (${updated.tokenCount} tokens)`,
            },
          ],
          details: { valid: updated.validation.valid, tokenCount: updated.tokenCount },
        };
      }

      // Execute ob-cli
      const args: string[] = ["--mode=memory"];
      if (params.action === "query") {
        if (params.query) args.push(`--query=${params.query}`);
        if (params.tag) args.push(`--tag=${params.tag}`);
        args.push("--json");
      } else if (params.action === "capture") {
        if (params.content) args.push(`--capture=${params.content}`);
        if (params.title) args.push(`--title=${params.title}`);
        if (params.tags) args.push(`--tags=${params.tags}`);
      } else if (params.action === "cat") {
        args.push("--cat");
        if (params.file) args.push(params.file);
      }

      const res = spawnSync("ob-cli", args, {
        encoding: "utf8",
        env: {
          ...process.env,
          MOE_STATE_DIR: stateDir,
        },
      });

      const output = (res.stdout || "") + (res.stderr ? `\n${res.stderr}` : "");
      return {
        content: [{ type: "text", text: output.trim() || `(ob-cli completed with code ${res.status})` }],
        details: { exitCode: res.status },
      };
    },
  });
}
