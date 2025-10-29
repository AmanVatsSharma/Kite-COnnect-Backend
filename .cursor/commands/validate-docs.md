Cross-verify all docs vs actual files and dependencies. Warn for mismatches or outdated info.



```markdown
# Validate Docs

## Goal
Cross-check documentation consistency across the codebase.

## Scope
- All `.doc.md` files and corresponding source files.

## Actions
1. Compare file paths in YAML headers vs actual file existence.
2. Validate metadata keys: `file`, `description`, `layer`, `status`, `last_updated`.
3. Detect outdated docs (missing functions, wrong dependencies).
4. Report discrepancies in `docs-report.json`.

## Rules
- Never edit source code.
- Flag discrepancies; don’t auto-fix.

## Output
- `.cursor/cache/docs-report.json`
- Console summary: total docs valid %, outdated %.

## Example Use