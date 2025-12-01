# Cursor AI — Enterprise Refactor Plan

**SonuRam ji — Purpose:** A compact, enterprise-grade .md command plan for Cursor AI to refactor `src/` and configs for scalability, clean architecture, and maintainability. The agent must auto-detect current state, present a preview diff, then safely apply changes while keeping backward compatibility and ensuring builds/tests pass.

---

## 1. Goals

* Standardize folder/module naming and patterns (module-wise, feature-first).
* Move shared logic into `/shared/` or `/lib/`.
* Normalize filenames (`PascalCase` for classes, `kebab-case` for folders, `camelCase` for variables, `snake_case` only for DB fields if needed).
* Make imports absolute using `tsconfig` paths and update automatically.
* Ensure ESLint + Prettier + tests + CI remain green.

## 2. Pre-check (required)

Cursor AI must run these checks before proposing or applying changes:

1. `git status --porcelain` — ensure clean working tree.
2. Detect package manager: `pnpm | yarn | npm`.
3. Detect language and framework (TS/JS, NestJS, Next.js, Node libs).
4. Parse `tsconfig.json` and `package.json` scripts.
5. Gather list of entry points (server `main.ts`, pages, lambda handlers).
6. Run `npm run build --if-present` (or equivalent) and capture baseline build success.
7. Run unit tests `npm test` (if present) and capture baseline.
8. Compute current import graph (file -> imports) and circular dependencies.

Output: JSON report `refactor-scan.json` with counts: files, modules, ambiguous folders, circulars.

## 3. High-level Strategy

1. **Feature Modules**: group by domain (`/features/auth/`, `/features/tasks/`) with `module` entry files (e.g. `tasks.module.ts`).
2. **Shared Layer**: common utilities, DTOs, types, errors, guards under `/shared/`.
3. **Infrastructure Layer**: DB drivers, external API adapters in `/infra/`.
4. **Application Layer**: use-cases / services under `/application/` or inside feature modules.
5. **Interface Layer**: controllers, GraphQL/resolvers, REST handlers under each feature's `interface/` subfolder.
6. **Config & boot**: keep `config/` and `main.ts` in root `src/`.

This yields clear vertical slices and enforces separation of concerns.

## 4. Recommended Folder Tree (optimized)

```
src/
├─ config/
│  └─ index.ts
├─ shared/
│  ├─ dtos/
│  ├─ types/
│  ├─ utils/
│  └─ errors/
├─ infra/
│  ├─ db/
│  └─ external/
├─ features/
│  ├─ auth/
│  │  ├─ interface/
│  │  │  ├─ auth.controller.ts
│  │  │  └─ auth.routes.ts
│  │  ├─ application/
│  │  │  └─ auth.service.ts
│  │  ├─ domain/
│  │  │  └─ user.entity.ts
│  │  └─ auth.module.ts
│  └─ tasks/
│     ├─ interface/
│     │  └─ tasks.controller.ts
│     ├─ application/
│     │  └─ tasks.service.ts
│     ├─ domain/
│     │  └─ task.entity.ts
│     └─ tasks.module.ts
└─ main.ts
```

Notes:

* File names: `auth.controller.ts`, `tasks.service.ts`, `tasks.module.ts`.
* Folder names: `kebab-case` (e.g., `features`, `auth`), exported classes use `PascalCase`.

## 5. Naming Conventions (strict)

* Folders: `kebab-case`.
* Files: `kebab-case` except `*.module.ts`, `*.controller.ts`, `*.service.ts`, `*.repository.ts` — maintain these suffixes.
* Classes: `PascalCase` (e.g., `AuthService`).
* Interfaces and types: prefix `I` for interfaces optional (`IUser`) — be consistent.
* Constants: `UPPER_SNAKE_CASE`.

## 6. Automatic Refactor Rules (regex-driven)

* Rename controllers: `(^|/)auth\.controller\.(ts|js)$` -> `auth.controller.ts` (normalize suffix).
* Move files into module folder if imports show strong coupling: heuristic = > 3 imports from feature.
* Replace relative imports like `../../../shared/utils` with `@shared/utils` and add `tsconfig` path mapping.

Regex examples for Cursor AI engine (must run in dry-run):

* Find files to rename:

  * `(?i)([A-Za-z0-9_\-]+)\.controler\.(ts|js)` -> fix common typo `controler` -> `controller`.
* Fix duplicates:

  * `(.+)\.(test|spec)\.(ts|js)$` keep under `__tests__` where desired.

## 7. Import Path Normalization

* Add/update `tsconfig.json` `paths`:

```json
"paths": {
  "@shared/*": ["src/shared/*"],
  "@features/*": ["src/features/*"],
  "@infra/*": ["src/infra/*"]
}
```

* Run an import rewrite tool (Cursor AI step): parse AST and replace relative paths with matching `@` alias.
* Ensure `eslint` + `tsserver` aware of paths.

## 8. Linting & Naming Rules (ESLint + plugin)

* Enforce with `@typescript-eslint/naming-convention` rules for classes, variables, functions.
* Add rule samples in `.eslintrc.json` snippet in output and auto-apply.

## 9. Backward Compatibility Strategy

* **Preserve public API**: keep old paths by adding re-export files at previous locations for 1 release cycle.
* Use `index.ts` in moved folders to export `export * from '../features/auth/auth.controller';` so old imports still work.
* Create a `migration-map.json` with `oldPath -> newPath` used for automated `codemods` and as runtime fallbacks.

## 10. Tests & CI

* Always run in dry-run mode first:

  * `npm run lint && npm run build && npm run test` (fail fast)
* Add `refactor:verify` script that runs the above.
* For large projects, split tests by module to run in parallel.

## 11. Rollout Plan (steps Cursor AI should follow)

1. **Scan** — produce `refactor-scan.json`.
2. **Propose** — produce a patchset (git branch `refactor/structure-YYYYMMDD`) with human-readable PR summary and file diff preview.
3. **Dry-run apply** — apply changes to working tree but don't commit; run `build` & `test`.
4. **Create compatibility exports** — add index re-exports for moved files.
5. **Commit & push** — `git commit -m "refactor: restructure src for clean architecture"`.
6. **Open PR** with automated checklist.
7. **Monitor CI**; if CI passes, merge.
8. **Deprecation** — after one release, remove compatibility re-exports and update `migration-map.json`.

## 12. Safety & Edge Cases

* Skip any file pattern with `// @no-refactor` comment.
* Ignore binary files and third-party vendor folders.
* When ambiguous (e.g., file used by multiple domains), prompt user with ranked suggestions and keep original until confirmation.

## 13. Cursor AI Task Templates (use as agent `tasks`)

### scan (dry)

```bash
cursor-ai run --task scan-structure --output refactor-scan.json
```

* Purpose: create baseline report.

### propose

```bash
cursor-ai run --task propose-refactor --input refactor-scan.json --output patchset/
```

* Purpose: create git patchset and human diff.

### apply (dry-run)

```bash
cursor-ai run --task apply-refactor --patch patchset/ --dry-run
# then run: npm run build && npm test
```

### apply (commit)

```bash
cursor-ai run --task apply-refactor --patch patchset/ --commit --branch refactor/structure-$(date +%Y%m%d)
```

### revert

```bash
git checkout main && git reset --hard origin/main
```

## 14. Validation Checklist (automated)

* [ ] `git status` clean before start
* [ ] `refactor-scan.json` contains >0 files
* [ ] No circular deps introduced
* [ ] `npm run lint` green
* [ ] `npm run build` green
* [ ] `npm test` green
* [ ] Manual review added to PR
* [ ] Migration map created

## 15. Deliverables

1. `refactor-scan.json` (baseline)
2. `patchset/` (git patch files)
3. `migration-map.json`
4. `refactor-PR.md` (automated PR description)
5. `refactor-verify.sh` script to run checks

---

## Final notes for the Cursor AI agent

* Always offer a preview and a single `--apply` button. Do not mutate master/main directly.
* Keep changes atomic and per-module so rollbacks are easy.
* When in doubt, create compatibility re-exports and mark deprecated with TODO + date.

*Make the project so organized that even future-you will feel ashamed for past chaos.*

