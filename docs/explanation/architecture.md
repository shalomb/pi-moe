# Architecture: How `pi-moe` Works

`pi-moe` separates **conversational continuity and intent routing** (Moe) from **high-context execution** (the Mixture-of-Experts delegates).

## 1. The Problem: Distracted Agents and Context Rot

When a single coding agent session is used for everything—brainstorming, reading 40 files, running test suites, debugging stack traces, and managing notes—three failure modes occur:
1. **Context Window Bloating & Cache Thrashing**: Tool outputs rapidly push the conversation past 100k+ tokens, increasing latency/cost and forcing lossy compaction that erases earlier user intent.
2. **The Distracted Agent Anti-Pattern**: With 80+ skills and multiple responsibilities competing for attention, instruction adherence drops sharply.
3. **Fate Sharing under OOM**: A runaway test runner, language server, or build inside the agent's process tree triggers the kernel OOM killer and takes down the entire session.

## 2. The Solution: Executive Router + Isolated Experts

### Moe (The Always-On Companion)
- Hosted via a `systemd --user` service (`pi-moe.service`) running `pi` with `pi-mobile` (`/remote`) enabled.
- Protected from kernel OOM via `OOMScoreAdjust=-500`.
- Carries a minimal, static system prompt plus `focus.md` (~1,000 tokens).
- Never performs heavy repository file reads or build loops directly; instead, invokes deterministic CLIs (`gum`, `todo`, `ob-cli`) or dispatches a specialist delegate.

### Cgroup-Isolated Delegate Execution
Every heavy delegate is launched via a transient systemd scope:
```bash
systemd-run --user --scope \
  -p MemoryMax=4G \
  -p OOMScoreAdjust=500 \
  --unit="pi-moe-worker-${TASK_ID}" \
  pi --mode json ...
```
If a build or test suite exhausts memory, the kernel terminates only `pi-moe-worker-${TASK_ID}`. Moe remains alive, records the failure in the task receipt, and alerts the user via `pi-mobile`.

### Prompt-Cache-Friendly Memory Grooming
Rather than mutating the system prompt or middle transcript messages on every turn (which invalidates provider prefix caches), `pi-moe` treats active chat as append-only and performs **Memory Grooming** at natural boundaries:
- Before background compaction (`before_compact` hook)
- On task completion (`todo done`)
- During scheduled idle consolidation ("closing time at Moe's")
