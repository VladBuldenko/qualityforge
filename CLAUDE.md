# QualityForge / WalletShop — Agent Instructions

WalletShop (`apps/web` React+Vite, `apps/api` Express+Prisma, PostgreSQL, Docker Compose) is a demo FinTech + e-commerce app.
No real funds or production payment operations. Run: `docker compose up -d --build`; API tests: `cd apps/api && npm test`.

## Automatic Git Commit and Push Policy

The user authorizes **local commits and ordinary pushes** to the configured GitHub remote after every successfully completed and verified development TASK. Do not ask for separate approval for these.
Remote: `origin` = `git@github.com:VladBuldenko/qualityforge.git` (public repo), branch `main` tracking `origin/main`.
Auth: dedicated deploy key `~/.ssh/qualityforge_deploy`, configured via this repo's `core.sshCommand`. Never display, copy, commit or upload the private key; never use account-wide GitHub auth.

At the start of every TASK, inspect `git status` and note existing changes. After the work is complete:

1. Inspect Git status and identify the files belonging to the task.
2. Run minimal relevant verification (tests, type checks, build, health check as applicable); fix blocking errors first.
3. Stage only task-related files, by explicit path (never `git add -A` or `git add .`).
4. Review staged files and diffs.
5. Verify no secrets, credentials, `.env` files, database volumes, generated dependencies (`node_modules`, `dist`), unrelated files, or nested Git repositories are staged. The repo is PUBLIC: nothing private may be committed.
6. Run `git diff --cached --check` (migration SQL is exempt from the EOF-blank-line rule via `.gitattributes`).
7. Create one logical local commit using Conventional Commits (separate commits allowed for independently verified blocks).
8. Verify the remote is the intended one and the upstream is `origin/main`.
9. Push with an ordinary `git push` (no force).
10. Confirm the remote branch contains the new commit (`git ls-remote origin main` matches `git rev-parse HEAD`).
11. Report the commit SHA, branch, GitHub commit URL (`https://github.com/VladBuldenko/qualityforge/commit/<sha>`), verification results, and remaining `git status`.

Never commit or push incomplete or broken work as a completed task. If verification is blocked, explain the blocker and leave changes uncommitted unless the user asks for a checkpoint commit. If a push is rejected, do not force it or rewrite history: report the problem. Do not create commits solely for incidental file changes.

### Commit naming (Conventional Commits)

`feat(auth): implement registration and login`, `feat(catalog): add physical and digital products`, `feat(cart): implement shopping cart`,
`feat(wallet): add EUR and USD accounts`, `feat(payments): integrate Stripe test payments`, `fix(auth): correct session handling`,
`chore(docker): improve development environment`, `docs: update project instructions`.
Messages must describe the actual changes.

## Git Safety

- Ordinary pushes of verified work are authorized. Never force push, merge branches automatically, rebase, delete branches (local or remote), or rewrite published history.
- Never `git reset --hard`, `git clean`, or otherwise destroy working-tree changes.
- Never stage `.env`, secrets, credentials, SSH keys, database files/volumes, `node_modules`, or `dist`.
- Never stage unrelated pre-existing changes: `docs/` (user's requirements) and the nested `qualityforge/.git` directory must stay untouched and uncommitted unless the user says otherwise.
- Do not change branches without a task-related reason. Never use `--no-verify`. Do not modify other repositories.
- Prisma migrations are checksummed once applied: never edit an applied migration.

## Development Preferences

- Working functionality first; simple architecture; no unnecessary abstractions.
- Minimal but meaningful tests; preserve existing functionality.
- Money: integer minor units (or precise decimals), DB transactions, idempotency where relevant.
- Keep migrations safe; never delete Docker volumes without explicit approval.
