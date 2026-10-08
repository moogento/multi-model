---
description: Run the same prompt against every configured provider and compare latency, usage, and response differences; never modifies files
argument-hint: [task-description] [--providers deepseek,glm]
allowed-tools: Bash(node scripts/multi-model/benchmark.js:*)
model: haiku
---

# Multi-Model Benchmark

**Task**: $ARGUMENTS

## Process

1. Run:
   ```bash
   node scripts/multi-model/benchmark.js --task "<task>" [--providers deepseek,glm]
   ```
2. Present a short comparison table to the user: provider, status, latency, approximate tokens (from `usage` when present), and a one-line qualitative note based on the `preview` text.
3. This command never touches any file - read-only, informational only.
