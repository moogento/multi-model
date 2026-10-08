---
description: Validate multi-model config and connectivity with a tiny harmless test prompt per configured provider; never exposes secrets
argument-hint: (no arguments)
allowed-tools: Bash(node scripts/multi-model/config-check.js:*)
model: haiku
---

# Multi-Model Config Check

## Connectivity result (pre-executed)

!`node scripts/multi-model/config-check.js`

## Your task

Present the per-provider result above (`OK` + latency and model, `not configured`, or `ERROR` + message) to the user as-is. If the pre-executed block above is empty or errored, run `node scripts/multi-model/config-check.js` yourself with Bash and present that output instead - do not ask the user what they want; running the check IS this command. Never print or guess at an actual key value, even if an error message might seem to reference one.
