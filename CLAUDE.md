# QualityForge / WalletShop — Agent Instructions

WalletShop (`apps/web` React+Vite, `apps/api` Express+Prisma, PostgreSQL, Docker Compose) is a demo FinTech + e-commerce app.
No real funds or production payment operations. Run: `docker compose up -d --build`; API tests: `cd apps/api && npm test`.

## Automatic Commit Policy

The user authorizes **local commits** after each successfully completed development TASK (no explicit request needed). Pushes are NOT authorized.

1. At the start of every TASK, inspect `git status` and note existing changes.
2. Record which files belong to the current TASK.
3. Implement the requested functionality.
4. Run minimal relevant verification (tests, type checks, build, health check as applicable).
5. Fix blocking errors before committing.
6. Stage only files created/modified for the current TASK, by explicit path (never `git add -A` or `git add .`).
7. Inspect staged files and staged diffs.
8. Confirm no secrets, unrelated files, nested repositories, or generated artifacts are staged.
9. Run `git diff --cached --check`.
10. Create one logical local commit per successfully completed TASK.
11. Several independently completed and verified blocks within a TASK may be committed separately.
12. Never commit incomplete or broken functionality as a successful task.
13. If verification is blocked, explain the blocker and leave changes uncommitted unless the user explicitly asks for a checkpoint commit.
14. After each commit, report the SHA, message, verification results, and remaining `git status`.
15. Apply this policy in all future sessions.

### Commit naming (Conventional Commits)

`feat(auth): implement registration and login`, `feat(catalog): add physical and digital products`, `feat(cart): implement shopping cart`,
`feat(wallet): add EUR and USD accounts`, `feat(payments): integrate Stripe test payments`, `fix(auth): correct session handling`,
`chore(docker): improve development environment`, `docs: update project instructions`.
Messages must describe the actual changes.

## Git Safety

- Never push, merge, rebase, force push, or rewrite history automatically.
- Never `git reset --hard`, `git clean`, or otherwise destroy working-tree changes.
- Never stage `.env`, secrets, credentials, database files/volumes, `node_modules`, or `dist`.
- Never stage unrelated pre-existing changes: `docs/` (user's requirements) and the nested `qualityforge/.git` directory must stay untouched and uncommitted unless the user says otherwise.
- Do not change branches without a task-related reason. Never use `--no-verify`.
- Prisma migrations are checksummed once applied: never edit an applied migration (`.gitattributes` relaxes the EOF whitespace check for them).

## Development Preferences

- Working functionality first; simple architecture; no unnecessary abstractions.
- Minimal but meaningful tests; preserve existing functionality.
- Money: integer minor units (or precise decimals), DB transactions, idempotency where relevant.
- Keep migrations safe; never delete Docker volumes without explicit approval.
