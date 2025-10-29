## Summary: 
Deep scan of repo — index structure, modules, docs, dependencies, env, etc. (the one you mentioned)


# Scan Project

## Goal
Perform a deep structural scan of the entire repository and produce an internal project index, identifying all modules, dependencies, and documentation completeness.

## Scope
- All source folders (`src`, `apps`, `packages`, etc.)
- All `.ts`, `.js`, `.tsx`, `.jsx`, `.json`, `.md` files
- `.cursor/cache/` for generated metadata

## Actions
1. Traverse all directories recursively.
2. Identify modules, layers (frontend/backend/shared/tests).
3. Map inter-file imports and dependencies.
4. Check if each module has its `.doc.md` metadata file.
5. Validate existence of a YAML header in each `.doc.md`.
6. Build a dependency graph and summary table.

## Rules
- Never modify project code; read only.
- Skip `node_modules`, `dist`, `build`, `coverage`.
- Store scan result as `project-map.json` under `.cursor/cache/`.
- Use relative paths; no absolute OS paths.

## Output
- `.cursor/cache/project-map.json`
- Console summary of total modules, missing docs, invalid headers.

## Example Use
