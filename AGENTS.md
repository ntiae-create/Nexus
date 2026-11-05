# Repository rules

- Prepare shared packages in dependency order (shared, assistant-profiles, database, tools) before consumers; workspace exports resolve to generated dist files.
- Declare Vite 7 at the workspace root as well as the mobile workspace so mobile plugins and Vitest resolve compatible peer types without forced overrides.
- Validate dependency changes from a clean npm ci with Node 24 and npm 11, followed by the root test and build commands; do not bypass peer dependency or TypeScript errors.