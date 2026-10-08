---
description: Show configured multi-model providers, selected models, which API keys are present, and usage totals (never prints key values)
argument-hint: (no arguments)
allowed-tools: Bash(node scripts/multi-model/provider-status.js:*)
model: haiku
---

# Multi-Model Provider Status

## Status (pre-executed)

!`node scripts/multi-model/provider-status.js`

## Your task

Present the output above as-is to the user. If the pre-executed block above is empty or errored, run `node scripts/multi-model/provider-status.js` yourself with Bash and present that output instead - do not ask the user what they want; showing the status IS this command. Never print or infer an actual key value - only "OK"/"MISSING" and the environment variable name.
