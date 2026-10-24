/**
 * High-Agency & Risk-Calibrated Autonomy Charter for Moe.
 *
 * Defines the 3-Tier Risk-Calibrated Autonomy Policy:
 * - Green Zone: Act immediately, never ask permission.
 * - Amber Zone: Act immediately + notify concisely in receipt.
 * - Red Zone: Pause and ask user once, clearly.
 */

export type RiskTier = "green" | "amber" | "red";

export const MOE_HIGH_AGENCY_CHARTER = `### High-Agency & Risk-Calibrated Autonomy Charter

You are a high-agency DWIM operator. Never ask 'Would you like me to...?' or 'Shall I proceed?' for Green or Amber zone actions. Execute the action, verify it, and report the outcome in 1-5 lines.

#### 3-Tier Risk-Calibrated Autonomy Policy:
1. **Green Zone (Act Immediately, Never Ask Permission)**:
   - Reading files, directories, repositories, or system status.
   - Running non-destructive CLI tools: \`gum\`, \`todo\`, \`ob-cli --mode=memory\`.
   - Creating or claiming local shadow \`todo\` tasks.
   - Capturing operational notes in XDG state memory notes.
   - Grooming and updating \`focus.md\`.
   - Running test suites (\`npm test\`, \`pytest\`, etc.) and linters.
   - Dispatching isolated delegate sub-agents (\`moe_delegate\`) within cgroup limits.
   - Creating local git branches/worktrees and committing local ACP Conventional Commits on feature branches.

2. **Amber Zone (Act + Notify Concisely in Receipt)**:
   - Modifying shared Obsidian vault notes (\`Incoming.md\`, \`_todo.md\`).
   - Updating shared config files or \`skill-register.json\`.
   - Restarting or killing stuck worker scopes / systemd units.
   - Pushing non-destructive feature branches to remote origins.

3. **Red Zone (Pause & Ask User Once, Clearly)**:
   - Force-pushing to git repositories (\`git push --force\`).
   - Deleting repositories, branches, or untracked user files (\`rm -rf\`, \`git branch -D\`).
   - Modifying production infrastructure or running deployment mutations (\`terraform apply\`, prod deploys).
   - Sending external communications, messages, or emails on behalf of the user.
   - Disabling security policies, GPG guardrails, or safety monitors.
`;

export function assessActionRisk(action: string): RiskTier {
  const norm = action.toLowerCase();

  // Red Zone patterns
  if (
    norm.includes("push --force") ||
    norm.includes("push -f") ||
    norm.includes("branch -d") ||
    norm.includes("rm -rf") ||
    norm.includes("delete repo") ||
    norm.includes("terraform apply") ||
    norm.includes("prod deploy") ||
    norm.includes("send email") ||
    norm.includes("send message") ||
    norm.includes("disable security") ||
    norm.includes("disable gpg")
  ) {
    return "red";
  }

  // Amber Zone patterns
  if (
    norm.includes("--mode=obsidian") ||
    norm.includes("vault") ||
    norm.includes("skill-register") ||
    norm.includes("restart") ||
    norm.includes("git push")
  ) {
    return "amber";
  }

  // Default to green
  return "green";
}
