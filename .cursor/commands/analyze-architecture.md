Understand overall app design, framework layers, data flow, and find architectural weaknesses.

# Analyze Architecture

## Goal
Understand and visualize the system’s architecture — layers, services, and communication flow.

## Scope
- Entire codebase and dependency map.

## Actions
1. Parse `project-map.json`.
2. Identify layers (UI, API, Services, DB, Utils).
3. Draw high-level architecture summary in `architecture.md`.
4. Detect circular dependencies and coupling.
5. Recommend improvements (e.g., separate auth logic from core services).

## Rules
- Read-only command; produces documentation only.
- Don’t rename or refactor code.

## Output
- `architecture.md` under `/docs/`
- Console visualization summary.

## Example Use
