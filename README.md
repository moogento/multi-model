# Multi-model

Advisory drafts, code reviews, explanations and outcome statistics using configured DeepSeek, GLM and OpenRouter accounts. The calling agent retains shell access, applies changes and verifies every result.

## Install into a project

Requires Git, Python 3 and Node.js 20 or newer. Clone this repository, then install its allowlisted toolkit into a project checkout:

```sh
git clone https://github.com/moogento/multi-model.git
cd multi-model
npm install
python3 scripts/multi-model/sync.py --source . --target /path/to/project
```

The project needs `dotenv` available to its Node runtime (`npm install dotenv` if absent). Review and commit the installed files and `.multi-model-sync.json`. Configure keys only in the project's ignored `.secrets/multi-model.env`. Never commit keys or runtime logs.

The installed skills and commands work from the project root. Plugin discovery alone does not install the runtime into a project. After the sync step, Claude users may register this repository as a marketplace, like Bounty and Zap:

```text
/plugin marketplace add https://github.com/moogento/multi-model.git
/plugin install multi-model@multi-model
```

A Codex compatibility manifest and portable skill are also included. Existing project-local skill discovery works immediately after sync.

## Update in either direction

Keep this clone as the shared upstream. Pull its Git updates, preview the import, then apply in a project feature worktree:

```sh
git pull --ff-only
python3 scripts/multi-model/sync.py --source . --target /path/to/project-worktree --check
python3 scripts/multi-model/sync.py --source . --target /path/to/project-worktree
```

To publish improvements developed in a project, use a feature worktree of this repository as the target:

```sh
python3 scripts/multi-model/sync.py --source /path/to/project-worktree --target /path/to/multi-model-worktree --check
python3 scripts/multi-model/sync.py --source /path/to/project-worktree --target /path/to/multi-model-worktree
```

Stage new source files before exporting. The tool reads only tracked allowlisted toolkit scripts, tests, skills and commands. It never exports project history, credentials, runtime ledgers, generated patches or unrelated files. The committed target baseline detects edits on both sides and refuses the whole operation before writing if they conflict. Target-only edits are preserved when upstream has not changed. Tracked upstream deletions propagate when the target is unchanged. Review the diff, run tests, then commit and push normally. The tool does not commit, push or fetch for you.

## Verify and use

```sh
npm test
MULTI_MODEL_CLIENT=codex node scripts/multi-model/provider-status.js
MULTI_MODEL_CLIENT=codex node scripts/multi-model/outcome-stats.js
```

Use `MULTI_MODEL_CLIENT=claude` for Claude ledgers. Provider status and statistics are local reads. Connectivity checks and draft/review commands make billable external requests.

See [toolkit documentation](scripts/multi-model/README.md) for commands, configuration, safety boundaries and cost limitations. References there to `.tools`, `.guidelines`, `/moo` and `/rr` describe optional integrations in the originating project. They are not shipped here and are not required by the core toolkit.
