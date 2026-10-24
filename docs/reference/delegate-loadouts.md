# Mixture-of-Experts Delegate Loadouts

To prevent the *Distracted Agent* anti-pattern, each specialist in `pi-moe` boots with a role-specific skill manifest (`skill-tiers.json`) that exposes only the verified skills required for its single responsibility.

## Role Registry

| Role | Persona | Tier-1 Pinned Skills | Primary Tools / CLIs | Output Contract |
| :--- | :--- | :--- | :--- | :--- |
| **Executive** | **Moe** | `todo-navigator`, `git-repo-discovery` | `gum`, `todo`, `ob-cli`, `moe-dispatch` | Concise reply / mobile notification |
| **Knowledge Curator** | **Librarian** | `obsidian-notetaker` | `ob-cli --mode=obsidian\|memory` | Committed/tagged note path + summary |
| **Product & Planner** | **Marge / Lisa** | `marge-product-agent`, `lisa-planning-agent`, `todo-navigator`, `architecture-decision-records` | `todo`, `gum` | Updated shadow `TODO.md` DAG + ADR/spec |
| **Builder** | **Ralph** | `modern-cli-overrides`, `test-driven-development`, `farley-tdd`, `git-commit-formatter`, `git-safety-guardrails`, `verification-before-completion` | Repo toolchain, `git`, `todo` | Tested ACP commit SHA + 5-line receipt + `skill_friction` |
| **Adversarial Reviewer** | **Bart** | `bart-adversarial-reviewer`, `test-design-review`, `farley-tdd` | `git diff`, test runner | `APPROVED` or structured findings in `FEEDBACK.md` |
| **Release & Ops** | **Lovejoy / Ops** | `lovejoy-release-agent`, `tmux-remote-control`, `daily-status` | `gh`, `tmux`, `sessions` | Release receipt or workstation status digest |

## Just-In-Time (JIT) Skill Evolution

Every delegate completion receipt includes an optional `skill_friction` field:
- Did a skill lack a deterministic helper script?
- Were instructions ambiguous or outdated?
- Did the agent have to improvise a complex shell pipeline?

When `skill_friction` is reported, Moe queues a JIT improvement task in `~/shalomb/agent-skills` to codify the fix into a script or updated `SKILL.md` and update the skill's verification status.
