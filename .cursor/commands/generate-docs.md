# Generate Docs

## Summary
Ensure every folder or module has a `.doc.md` file describing it, with headers and metadata extracted from code.

## Goal
Automatically create or update `.doc.md` documentation files for each module detected in the project.

## Scope
- Operates on all files detected by `scan-project`.
- Place documentation folder/file near each module.

## Actions
1. Read `project-map.json` to list all modules.
2. For each module missing a `.doc.md`, create one with the following YAML header:

   ```yaml
   ---
   file: <filename>
   description: <auto-summary-from-comments-or-code>
   layer: <frontend|backend|shared>
   dependencies: []
   status: draft
   last_updated: <today>
   ---
   ```

3. Generate a short functional summary below the header.
4. Update documentation if existing docs are stale (older than 30 days).

## Rules
- Never overwrite manually written sections of documentation.
- Always back up existing docs before updating.

## Output
- All modules have valid `.doc.md` files.
- Outputs a report listing newly created or updated documentation files.

## Example Use