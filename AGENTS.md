# AGENTS.md

Instructions for coding agents working in this repository.

## Git: use it freely

This project's git repository is yours to operate. **Automatically create git
commits as you see fit — do not ask for permission first.**

- Commit whenever a meaningful, self-contained step is finished: a feature, a
  fix, a refactor, a doc update, a test addition. Several small commits are
  preferred over one large catch-all commit.
- Do not leave a working tree full of uncommitted changes when you stop. If
  the work is incomplete, commit it on a clearly named branch (e.g.
  `wip/<topic>`) rather than squatting on a dirty tree.
- Use normal git commands directly: `git status`, `git diff`, `git add -p`,
  `git commit`, `git log`, `git branch`, `git switch`, etc. You may create
  branches, amend your own unpushed commits, and use `git stash`/`git restore`
  to manage work in progress.
- Never commit secrets, credentials, tokens, or local machine paths. Check
  `git status` and the diff before staging; `.gitignore` already covers the
  obvious local artifacts.
- Keep `main` working: run the checks below for the files you touched before
  committing to it.
- Do not rewrite pushed history (`push --force`, rebasing public branches)
  unless explicitly asked. Do not add or change remotes, and do not push,
  unless explicitly asked.

### Commit messages

Short imperative subject line, optionally prefixed by area, e.g.
`client: fix chip flicker on refresh`. Keep the subject under ~72 characters.
Add a body only when the *why* is not obvious; wrap it at 72 columns.

## Project checks

```sh
node --check lib/index.js
node --check lib/client.js
node test/client-smoke.mjs      # bundle format + slot registrations
node test/host-live.mjs         # live Platform query (needs a signed-in account)
```

`test/host-live.mjs` touches the network and the local credential store, so it
is not required for every commit; the syntax checks and `client-smoke` are.

## Code conventions

- `lib/index.js` is the host half, `lib/client.js` is the browser bundle.
  Follow the existing style in each file; do not introduce new dependencies
  without good reason.
- Update `README.md` when behaviour, configuration, or the file table changes.
- Prices live in `PRICE_TABLE` in `lib/index.js`; keep `README.md` in sync.
