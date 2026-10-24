# Memory & Grooming Model

`pi-moe` avoids opaque vector databases in favor of human-inspectable, git-friendly Markdown files with strict YAML frontmatter, queried deterministically via `ob-cli`, `todo`, and `gum`.

## The Four Tiers

| Tier | Location | Purpose | Admission Policy |
| :--- | :--- | :--- | :--- |
| **Tier 0: Active Focus** | `~/.local/state/pi-moe/focus.md` | Pinned in Moe's system prompt (~1k tokens max). Active missions, running workers, immediate priorities, sharp semantic anchors. | Must fit within 1,000 tokens. Groomed on task transitions and idle sleep. |
| **Tier 1: Obsidian Vault** | `/media/psf/Home/obsidian/` | Long-term personal & engineering knowledge (`Incoming.md`, `_todo.md`, domain notes, syntheses). | **High bar**: Only durable insights, ideas, and reference material worth keeping for months/years. Managed via `ob-cli --mode=obsidian`. |
| **Tier 2: XDG Operational Memory** | `~/.local/state/pi-moe/memory/` | Operational context, workstation state, project quirks, session handoffs, and delegate receipts. | Tagged with YAML frontmatter (`tags`, `project`, `updated`) and queried via `ob-cli --mode=memory`. |
| **Tier 3: Repo Ground Truth** | `<repo>/docs/` + `~/.cache/agent-skills/todos/<slug>/` | Per-repository shadow backlogs (`TODO.md`, `tasks/<id>.md`), Diátaxis docs, ADRs, and Conventional Commits (`git log`). | Code and design truth lives with the repo and its shadow backlog. |

## Memory Grooming Rules

Following the *Memory Grooming* and *Learning Loop* patterns from [Augmented Coding Patterns](https://lexler.github.io/augmented-coding-patterns/):
1. **Deduplicate & Resolve Contradictions**: When updating `focus.md` or XDG memory files, merge duplicate entries and delete superseded facts.
2. **Use Semantic Anchors**: Replace verbose prose instructions with crisp domain terms (e.g., `TDD, Farley Index`, `Diátaxis`, `ACP Conventional Commits`).
3. **Delete Obsolete Operational Notes**: Once a decision is captured in a repo ADR, Diátaxis doc, or git commit, remove the temporary operational note from Tier 0/Tier 2.
