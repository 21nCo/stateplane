# Agent instructions

## Codex hooks (Entire)

- Entire's Codex hooks live in the global Codex config (`~/.codex/hooks.json`). Do not add or commit a repo-level `.codex/hooks.json`.
- `entire enable` and `entire agent add codex` write `.codex/hooks.json` into the repo. If you run either one, delete that file afterwards; it is gitignored so it should never reach a commit.
- If the Entire hooks are missing on your machine, add them to `~/.codex/hooks.json`, not to this repo.
