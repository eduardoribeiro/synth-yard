# Development Tooling

## Purpose

Synth Yard uses OXC for fast linting and formatting, and TypeScript for gradual static typing. JavaScript remains supported while the client and server are migrated file by file.

## Commands

Run these from the repository root:

| Command             | Purpose                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `pnpm lint`         | Lint Node server code, Jest tests, and React client source with OXC.                             |
| `pnpm lint:fix`     | Apply OXC's safe lint fixes to Node and React source. Review the resulting diff before committing. |
| `pnpm format`       | Verify OXC formatting for `server/` and `client/src/`.                                            |
| `pnpm format:write` | Format Node server and React client source in place with OXC.                                    |
| `pnpm typecheck`    | Type-check TypeScript files in both the CommonJS server and Vite client without emitting output. |

`pnpm build` continues to build the Vite client. Use `pnpm typecheck` in addition to the build while migrating code.

## TypeScript Migration

- Server code is configured in the root `tsconfig.json`. Keep server modules CommonJS until each file is intentionally migrated, then use `.ts` with the existing module boundaries.
- Client code is configured in `client/tsconfig.json`. Convert React components from `.jsx` to `.tsx` and other modules from `.js` to `.ts` one file at a time.
- Both configurations set `allowJs: true` and `checkJs: false`. Existing JavaScript keeps its runtime behavior and does not block the migration with retroactive diagnostics.
- New TypeScript files are checked with `strict: true`, `noEmit: true`, and no generated JavaScript. Vite compiles client TypeScript, while `tsx` executes server TypeScript and preserves the current CommonJS module resolution during the migration.
- Add explicit types at API and driver boundaries first. Do not change scheduler behavior, status transitions, or part-count paths merely as part of a file extension conversion.

## Configuration Files

| File                   | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `.oxlintrc.json`       | OXC lint ignore rules for generated and farm data.                             |
| `.oxfmtrc.json`        | Explicit OXC formatter configuration, currently using OXC defaults.            |
| `tsconfig.json`        | Strict, no-emit TypeScript configuration for server migrations.                |
| `client/tsconfig.json` | Strict, no-emit TypeScript configuration for React and Vite client migrations. |
| `tsconfig.test.json` | TypeScript configuration used by `ts-jest` for server test migrations. |
| `jest.config.cjs` | Runs TypeScript tests through `ts-jest` while JavaScript tests continue unchanged. |

The format and lint scripts explicitly target `server/` and `client/src/`. Documentation, deployment files, and other project configuration remain outside the formatting scope.
