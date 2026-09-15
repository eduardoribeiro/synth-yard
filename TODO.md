# TODO.md - Roadmap

Planning document for the fork of Print Farm Manager. This is an owned fork: the owner of this repository makes the product decisions here, not the upstream maintainer. Everything below is written against that reality.

## Vision and ownership

- **North star:** an open-source, self-hosted-first 3D printer management platform at the level of a commercial service like SimplyPrint: multi-brand monitoring, telemetry, remote control, spool and filament management, camera streaming, notifications, and statistics, without locking operators out of their own data.
- **Commercial path:** an optional paid cloud offering may come later (managed hosting, team features). Self-hosting remains first-class and feature-complete: every feature that ships in the cloud edition ships in the self-hosted edition. The cloud is convenience, not a gate.
- **License reality:** the upstream project is MIT (see LICENSE, Copyright (c) 2026 Joel Telling). MIT permits forking, rebranding, and charging for hosted or modified versions, with one hard requirement: the original copyright notice must be preserved in copies and substantial portions of the code. The rebrand track below must keep that attribution intact.
- **Local-first architecture stays:** the server currently reaches printers directly on the LAN. That model is the product's core strength and the reason it works with zero external services. The cloud track must extend it, never replace it.

---

## Part 0: Assessment of what exists today (verified in code)

### 0.1 Adding a printer: over-engineered, confirmed

- The only single-printer add flow is the Add Printer section in Settings (`client/src/pages/Settings.jsx`). The Printers page has no add affordance.
- The form collects `name`, `ip`, `api_key`, `serial_number`, `model`, `group_name`, `type`, `loaded_material`, `loaded_color`, and the model must first be pre-registered in a separate Printer Models section (`model_id`, `label`, `connector`). Two-step ceremony for every new machine.
- The form mixes connection fields, routing (`group_name`), and material state (`loaded_material`/`loaded_color`). Every field renders for every connector, softened only by help text, even though credentials are connector-dependent (Bambu needs serial + access code, Klipper/Elegoo need none).
- Bulk onboarding already works well via CSV import with model inference and a flagged-rows rescue flow.

### 0.2 Materials: a pick-list, not an inventory

- The Filament Library is exactly two tables: `filament_types` (name only) and `filament_colors` (`type_id`, `name`, `hex_color`). See `docs/filaments.md` and `server/routes/filaments.js`.
- No brand, vendor, weight, remaining quantity, price, or purchase date anywhere.
- The scheduler matches G-codes to printers on free-text strings (`printers.loaded_material`/`loaded_color` vs `gcodes.required_material`/`required_color`). Any richer inventory must keep those strings working.

### 0.3 Telemetry: fetched, then discarded

- The driver contract (`docs/driver-authoring.md`) returns exactly `{ status, progress, timeRemaining, currentFile }`. The poller (`server/poller.js`) persists only `job_name`, `job_progress`, `job_time_remaining`.
- No bed/nozzle/chamber temperature, fan state, light state, or camera frame exists in the DB, the API, or the UI. `GET /api/printers/:id/raw-status` is a debug passthrough, not structured telemetry.
- Several drivers already receive richer data and throw it away: Creality collects WebSocket telemetry frames, Bambu MQTT pushes temperature and fan payloads, Moonraker and OctoPrint expose heaters and fans over their APIs. The plumbing exists; the contract and storage do not.

### 0.4 UI stack: hand-rolled by design, with real cost

- Vite + React 18, exactly three runtime deps, inline `style={{}}` objects against a hard-coded dark palette, one small `index.css`, custom `useToast`/`useConfirm`.
- The "no CSS framework" rule was the upstream maintainer's minimal-dependency stance. It has a real cost: every form, modal, table, select, and notification is re-implemented by hand, which is exactly why surfaces like Add Printer feel over-engineered.
- Decision: adopt a component library, hybrid-first (see Track 4). This is an owner's call and it is made.

---

## Part 1: Decisions of record

| # | Topic | Decision | Status |
|---|---|---|---|
| G1 | Filament/spool tracking (parked upstream) | Resume; it is a competitive feature, not a side quest | Decided: yes |
| G2 | Printer diagnostics panel (parked upstream) | Resume as telemetry + control track | Decided: yes |
| G3 | Camera streaming (parked upstream) | Resume as a phased track, per-brand protocol docs first | Decided: yes, phased |
| G4 | Component library (Mantine or equivalent) | Adopt, hybrid-first; no full rewrite as a single step | Decided: yes |
| G5 | Spool consumption decrement on job finish | Engineering gate: full single-event/double-fire analysis before any code | Open: analysis required |
| G6 | Cloud architecture (how the cloud reaches printers) | Owner decision required before any cloud work starts | Open |
| G7 | Rebrand scope (name, repo, package names, docs) | Synth Yard, `eduardoribeiro/synth-yard`, and upstream attribution retained | Decided and started |

**Standing engineering rules (these are not governance, they protect the fleet and the community):** docs ship with the change, dated changelog entry per change, no em/en dashes in new prose, official protocol docs read before driver edits, hardware validation stated honestly, `parts.completed_qty` paths mechanically preserved, schema evolution additive only, better-sqlite3 always synchronous, timestamps in epoch ms.

---

## Part 2: Track 1 - Add Printer UX

Goal: add a printer from the Printers page in under a minute, with only the fields that printer's connector needs.

1. **Client:** "Add Printer" button on the Printers page toolbar opening a modal (hand-rolled or Mantine, see Track 4; this modal is the Mantine pilot if the dependency lands first). Guided order: connector select with per-brand credential help inline, model select grouped by connector, then only the credential fields that connector needs, then an optional collapsed "routing and material" section with a "you can set these later" note.
2. **Server:** `POST /api/printers` auto-registers a missing model (`INSERT OR IGNORE` into `printer_models`, label derived from the typed name, connector from the selected `type`) instead of failing. Removes the two-step ceremony; Printer Models stays for relabeling and cleanup.
3. **Tests:** new/extended printer route tests for auto-register success, existing-model passthrough, invalid connector. Sync pair: `server/routes/models.js` VALID_CONNECTORS stays authoritative; `docs/api.md` documents the new behavior.
4. **Acceptance:** creation works end to end for Prusa, Bambu, Klipper, Elegoo, OctoPrint, Creality; no Settings visit for a brand-new model; 409 name conflict and 400 validation behave exactly as today.

## Part 3: Track 2 - Spool inventory + OpenFilamentDatabase (G1: resumed)

Goal: turn the Filament Library into a real spool inventory with brands, weights, remaining quantities, and prices, with the open-filament-database dataset as an import source.

**2A Data model (additive only):** new `spools` table: `type_id` FK to `filament_types`, `color_id` FK to `filament_colors`, `brand`, `vendor`, `weight_grams`, `remaining_grams` (nullable until first weigh-in), `price`, `purchase_date`, `notes`, `status` (active/low/empty/archived), `loaded_printer_id` nullable FK, `created_at`. Optional `brands` registry table. `filament_types`/`filament_colors` stay canonical so scheduler string matching keeps working untouched. Schema evolution follows the house pattern: `CREATE TABLE IF NOT EXISTS` + additive `try/catch ALTER` in `server/db.js`. Sync pair: `server/routes/backup.js` export AND restore plus `server/tests/backup-restore.test.js`.

**2B API and UI:** `server/routes/spools.js` CRUD + `POST /api/spools/:id/adjust` for weigh-ins and corrections. House conventions: factory pattern, static-before-param ordering, 400/404/409 semantics, COALESCE partial updates, docs/api.md entry with fenced JSON, supertest coverage. Settings gains a Spools section with remaining-grams bars, add/edit form, low/empty badges surfaced as a passive banner, never toast spam.

**2C OpenFilamentDatabase import:** this is the server's first outbound call that is not to a printer. Confirm the exact dataset layout and license from the open-filament-database repo before writing the parser (the protocol-docs rule applies to datasets too). Operator-initiated import from Settings, local cache of the dataset, paste-a-JSON-snapshot fallback for air-gapped farms, Docker/firewall networking noted. Prices stay operator-entered per spool; the dataset never supplies prices.

**2D Consumption decrement (G5, highest risk, last):** optional decrement of the loaded spool's `remaining_grams` by `gcodes.material_grams` per plate on job FINISHED. Before code: the analysis the rule demands. What unique real-world event backs each decrement (the same FINISHED transition that credits `completed_qty`), and how process-lifetime and hold gates prevent double-fire across restart, reconnect, and poll flaps. Default philosophy when uncertain: ask the operator. Weigh-in and manual adjust are the fallback answers.

## Part 4: Track 3 - Telemetry, control, cameras (G2, G3: resumed)

Goal: temps, fans, lights, and controls on the printer surfaces, cameras phased in per brand.

**3A Driver contract, additive:** `getStatus` returns an optional `telemetry` key: `{ nozzleTemp, bedTemp, chamberTemp, fans: [{ name, rpm }], lights: [{ name, on }] }`, `null` when the protocol does not expose it. Existing return fields untouched, so no driver regresses by omission. `docs/driver-authoring.md` updates in the same commit. Per-driver work starts from official protocol docs: Moonraker objects, Bambu MQTT/OpenBambuAPI, Creality telemetry frames, OctoPrint temps, PrusaLink. Priority by real-world value: Klipper, Creality, Bambu, OctoPrint, Prusa. Every driver change labeled "implemented from protocol docs, not yet validated on hardware" until run on a real printer, with mocked transport tests per driver suite.

**3B Persistence and API:** new `printer_telemetry` table (additive): `printer_id`, `nozzle_temp`, `bed_temp`, `chamber_temp`, `fans_json`, `lights_json`, `read_at`. Poller writes the latest snapshot every poll; status transition logic untouched. Expose via `GET /api/printers/:id` joined snapshot (Fleet cards) or a `GET /api/printers/:id/telemetry` subresource (PrinterDetail). Backup sync pair applies.

**3C UI:** PrinterDetail gets a live machine-state panel (nozzle/bed/chamber temps, fan RPM) refreshed by the existing 15 s poll; a stale readout renders dimmed, never toasts. Fleet cards get a compact nozzle/bed temp line while printing. Palette and 600 px breakpoint rules apply.

**3D Control commands (after 3A-3C stable):** optional driver exports gated by a `capabilities` array so the UI only renders supported buttons: `pausePrint`, `resumePrint`, `setFan`, `setLight`. Documented stubs where unsupported (the Prusa cancel-stub pattern, never a best-effort guess). Fan/light toggles on PrinterDetail with confirm dialogs where they affect a running print; pause/resume only when the farm has an active job there. `cancelJob` unchanged. Driver work checklist applies in full.

**3E Cameras (phased, per brand):** simply streaming vendor APIs is out; each brand gets its own phase from its official protocol docs (Bambu OpenBambuAPI frames, Moonraker and OctoPrint webcam endpoints, and so on). Camera streams must not tax the poll loop or the farm bandwidth; thumbnail and on-demand full stream only. Label every phase "not yet validated on hardware" until tested.

## Part 5: Track 4 - Component library (G4: decided, hybrid-first)

- Add `@mantine/core` + `@mantine/hooks` (+ `@mantine/notifications` when the custom toast is retired). Mantine 7 supports React 18. Pure JS, so the Windows/Node pin (`>=26 <27` in package.json engines) is unaffected.
- Map the existing hex palette into the Mantine theme once, so the two systems do not visibly clash during the hybrid phase.
- Hybrid order: build new surfaces (Track 1 modal, Track 2 spool forms, Track 3 telemetry panel) with Mantine; leave existing pages hand-rolled; retire `useToast`/`useConfirm` behind Mantine-based equivalents only when every caller is migrated.
- Full conversion of existing pages is its own follow-up track, evaluated after two or three hybrid surfaces ship. Do not attempt it as one step.
- Track the bundle-size cost of the new deps in the build output; revisit if it balloons.
- Docs update in the same commit as the dependency lands: docs/web-app.md dependencies section, CLAUDE.md's "no CSS framework" claim, and this file.

## Part 6: Track 5 - Rebrand (G7: open)

The fork needs its own identity before public release. Scope the surface with a grep-first audit, then rename in one commit per surface:

- Repository and package names (`print-farm-manager`, `print-farm-manager-client` in both package.json files), Docker image names in the GHCR publish workflow (`.github/workflows/`), `update.bat`, README.md, docs/README.md, docs/installation.md.
- UI strings: sidebar/topbar farm name default, page titles, empty states.
- CLAUDE.md governance language: the "Joel decides" escalation rules and the parked-features section are upstream baggage; rewrite them for this fork's owner and decisions of record (Part 1 of this file is the starting point).
- Attribution: keep the MIT header with Joel Telling's copyright in LICENSE and preserve the notice in any redistributed copies per the license terms. Credits to the upstream project in README are good practice, not just compliance.

## Part 7: Track 6 - Cloud platform (G6: open)

The cloud offering must be designed before it is built. The single biggest decision is how a cloud instance reaches printers that sit behind home and office NAT.

**Architecture options to evaluate (G6):**
1. **Outbound agent on the farm box:** a small agent process runs next to this app and opens an outbound tunnel (WebSocket or similar) the cloud connects through. Works for every connector because the driver still talks to printers on the LAN; the agent is brand-agnostic. This is the most likely right answer; validate with a prototype.
2. **Cloud instance + vendor-cloud APIs:** works only for brands with outbound cloud connectivity (Bambu and Prusa class), and depends on third-party API terms. Supplement, not the primary path.
3. **Hybrid:** agent for LAN brands, vendor-cloud where the printer is cloud-only.

**Multi-tenancy:** start with per-tenant SQLite (one container per farm), matching the house pattern. Revisit when telemetry volume and observability demand a shared store. Never share a database between farms while `parts.completed_qty` correctness depends on single-tenant assumptions.

**Auth and multi-user (required for cloud, useful self-hosted):** the app currently has zero auth and assumes one operator on a trusted LAN. Cloud release requires accounts, sessions, roles (admin, operator, viewer), and farm sharing for teams. Self-hosted must support local accounts without any cloud dependency.

**Notifications:** beyond the in-app alert store: email and webhook out (and push later) so a print failure reaches an operator who is not staring at the Fleet page.

**Statistics:** the platform tracks enough history already (jobs, events, spools once Track 2 lands) to power per-printer and per-farm usage analytics (print hours, part counts, material consumption). Cheap and high-value for both editions.

**Mobile:** responsive web at the 600 px breakpoint is the floor; a PWA manifest is the cheap next step. Native apps are not on the roadmap until the web product is complete.

## Part 8: Track 8 - External job observability and import

**Goal:** make Synth Yard useful when operators start prints from a slicer, a vendor application, or the printer UI. The app must record and display observed jobs without requiring Synth Yard to dispatch them.

### 8A. Separate observed jobs from scheduler-owned jobs

- Add an additive `job_source` field or a separate observed-job record with explicit values: `synth_yard`, `slicer`, `printer_ui`, `unknown`.
- A driver reports the native file name, start state, progress, elapsed time, and terminal state when its protocol exposes them. The poller creates or updates an observed job when a printer enters PRINTING with no active Synth Yard job.
- Observed jobs appear in Fleet, Printer Detail, Jobs, and printer history with a clear `Observed` label. They retain start/end timestamps, final printer state, reported filename, and connector metadata.
- Never use an observed job as a scheduler dispatch lock. Synth Yard must not upload, cancel, delete, or replace an observed job unless the operator explicitly takes an action supported by that connector.

### 8B. Safe completion and inventory rules

- An observed FINISHED transition records the job as finished, but does **not** modify `parts.completed_qty` automatically. A filename, elapsed time, or 100 percent progress is not proof of which internal part or quantity was physically produced.
- Let an operator optionally link an observed job to a project/part after it finishes, then use the existing explicit quantity-confirmation flow to credit parts. The operator remains the real-world event anchor.
- Preserve the existing restart/reconnect protections: stale terminal states, OFFLINE to FINISHED transitions, and historical printer files must never create a new observed completion or credit.
- Repeated polls of the same running file update one observed job, not create duplicates. Define an idempotency key from printer ID, native job/file identity when available, and a process-safe start marker.

### 8C. Driver contract and UI

- Extend the optional driver telemetry contract with `nativeJob`: native job ID when available, filename, started-at time when available, elapsed seconds, progress, and raw terminal state. Do not guess unavailable fields.
- Implement connector by connector from official protocol documentation and real hardware validation: start with Creality and Sparkx hardware already on the farm, then Moonraker, OctoPrint, PrusaLink, and Bambu.
- Add a Printer Detail job history section that combines scheduler-owned and observed jobs but clearly identifies source, tracking confidence, and whether inventory was credited.
- Add an operator workflow to link an observed job to a project/part and confirm good quantity. Never infer a part association from the filename alone.

### 8D. Data retention and cloud readiness

- Retain observed job history locally by default, with configurable pruning for farms that generate high volumes of telemetry.
- Keep raw vendor payloads out of the main jobs table. Store a bounded, redacted diagnostic snapshot only when it materially helps connector support.
- This track is foundational for the future cloud and analytics products: job history, utilization, print hours, and failure rates must include work started outside Synth Yard.

## Part 9: Recommended sequencing

1. Track 7A (TypeScript foundation) and Track 7B (test foundation): establish the language and test harness before feature work grows further.
2. Track 7C and 7D: enforce Conventional Commits and automated semantic releases once the initial CI checks are stable.
3. Resolve G6 (cloud architecture) with the owner. G7 (rebrand) is decided and in progress.
4. Track 1 (Add Printer): standalone, low risk, and the Mantine pilot.
5. Track 3A-3C (telemetry contract, poller, API, UI): contract first, drivers in Klipper/Creality/Bambu/OctoPrint/Prusa order.
6. Track 2A-2C (spool tables, CRUD, OFD import): independent of Track 3.
7. Track 3D (control commands) after 3A-3C prove the telemetry pipeline; Track 2D (consumption) last, gated on the G5 analysis.
8. Track 6 cloud platform: architecture decision first, then auth, then agent prototype, then notifications and analytics. Camera streaming (3E) slots in per brand as protocol work allows; cloud edition does not depend on it.

## Part 10: Track 7 - Platform engineering foundation

### 7A. Full TypeScript migration

**Goal:** make TypeScript the source language for the complete application, server and client. New production JavaScript must stop after the foundation lands.

1. Add a root `tsconfig.json`, `client/tsconfig.json`, `@types/node`, `@types/express`, React type packages, and TypeScript-aware test configuration. Use strict mode for new and migrated files. Explicitly isolate untyped protocol payloads at driver boundaries with runtime checks rather than spreading `any` through scheduling code.
2. Convert the server first: shared types and DB row models, driver contract and registry, poller and scheduler, then routes. Maintain CommonJS compatibility initially only if it avoids a risky all-at-once module-system conversion. Compile server code before the Node runtime starts it.
3. Convert the client next: `main`, `App`, hooks, shared components, then pages. Use typed API response models shared through a workspace package or generated from a narrow API contract, not copy-pasted page interfaces.
4. Rename source files from `.js`/`.jsx` to `.ts`/`.tsx` only as each unit is type-clean. No mechanical mass conversion. Every migration PR must preserve behavior and pass the complete test suite.
5. Remove `allowJs` only when no production JavaScript remains. Tests can temporarily remain JavaScript during the first migration phase, then convert with the modules they cover.

### 7B. Automated testing: unit, integration, and end-to-end

**Goal:** expand the existing server Jest suite into a reliable quality gate for both the client and complete operator flows.

- Preserve existing server unit and route integration tests in `server/tests/`. They already use in-memory SQLite and mocked transports, which remains the right fast feedback layer.
- Add client unit and component tests with Vitest, React Testing Library, and jsdom. Cover form validation, request errors, safety confirmation behavior, status rendering, and the newly shared UI components.
- Add Playwright end-to-end tests. Start the real server against a disposable demo-seeded database and the built client, then test high-value workflows: add a printer, create project/part/G-code, operator Set Ready, spool adjustment, and an authentication flow when Track 6 starts.
- Make E2E independent of real printers and outbound network access. All printer transport is mocked or DEMO_MODE is used. Hardware validation remains a separate manual capability matrix.
- GitHub Actions runs server tests, client tests, E2E tests, type checking, and production build on pull requests and on `main`. Upload Playwright traces/screenshots only on failure.

### 7C. Conventional Commits and semantic versioning

- Adopt Conventional Commits: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, and `chore`, each with a lowercase scope where useful, for example `feat(spools): add manual weigh-in`.
- Enforce the format locally with Husky and commitlint, and in GitHub Actions so bypassing local hooks cannot create an unreleaseable merge.
- Follow Semantic Versioning: a `fix` is patch, `feat` is minor, and a commit with `!` or a `BREAKING CHANGE:` footer is major. Docs, test, and chore commits do not release on their own unless a release-relevant change is included.
- Maintain generated release notes. Hand-written entries in `docs/CHANGELOG.md` remain the product history during the migration, then reconcile or replace them only after the release tool is proven in production.

### 7D. Automated releases on merge to `main`

- Add a dedicated GitHub Actions release workflow triggered by a push to `main`, after CI succeeds. Use Release Please to read Conventional Commits, open or update a release PR, bump package versions and changelog content, then create the GitHub release and `vX.Y.Z` tag when that PR merges.
- The release workflow requires `contents: write` and `pull-requests: write`. Configure it to use `GITHUB_TOKEN` initially. If branch protection prevents the generated release PR from merging, use a fine-scoped GitHub App or token and document the setup in `docs/releases.md`.
- Change Docker publishing so it publishes immutable semantic image tags from the generated release tag, while `latest` tracks successful `main` builds. Docker publishing must remain gated by test, typecheck, build, and E2E jobs.
- Add `docs/releases.md`: contributor commit format, versioning rules, release flow, how to recover a failed release, and how self-hosted operators upgrade.

### 7E. Native Fetch migration

**Goal:** remove Axios and `form-data`, use Node's built-in Fetch API for every server HTTP request, and keep driver behavior equivalent.

- [x] Add `server/http.js`, with a tested `requestJson` helper that centralizes `AbortSignal.timeout`, JSON parsing, non-success `HttpError` responses, and query serialization. Its Moonraker regression test preserves empty object-query values.
- [ ] Migrate non-upload request paths first: PrusaLink status, Moonraker status, OctoPrint status, cancellation, and the raw-status diagnostic route. Read official protocol docs before each driver is edited.
- [ ] Migrate Prusa raw stream uploads with `Readable.toWeb`, explicit `Content-Length`, `duplex: 'half'`, and UPLOAD_CONFLICT regression coverage.
- [ ] Migrate native multipart uploads for Moonraker, OctoPrint, and Creality using built-in `FormData` and `Blob`, with protocol-specific upload tests.
- [ ] Replace Axios mocks with `server/http.js` mocks in driver tests, then remove `axios` and `form-data` only after the full suite passes.
- [ ] Update driver docs, server dependency docs, and hardware validation status as each connector migration lands.

## Part 11: Cross-cutting checklist (applies to every change)

- [ ] `pnpm test` passes in full (24 suites, ~378 tests, no skips added)
- [ ] Relevant docs/ component file updated in the same commit (web-app.md, api.md, driver-authoring.md, database.md, filaments.md, and the new spools/telemetry docs as they land)
- [ ] docs/CHANGELOG.md dated entry at the top, prose explains what and why
- [ ] No em/en dashes in new prose and comments (`grep -P '[\x{2013}\x{2014}]'` on changed files)
- [ ] Sync-pair audit: backup.js export/restore for every new table, models.js VALID_CONNECTORS for connector work, client Settings touchpoints for registry changes
- [ ] `pnpm build` succeeds for client changes; 600 px breakpoint respected for new layouts
- [ ] Driver work: protocol docs read first, mocked tests, honest "not yet validated on hardware" labeling
- [ ] Windows + Node (`>=26 <27` per package.json engines) respected; native module additions need extra scrutiny
- [ ] MIT attribution preserved: Joel Telling's copyright notice stays in LICENSE and substantial copies
- [ ] Commit message follows `feat(scope):` / `fix(scope):` / `docs:` / `chore(scope):` / `test(scope):` with a why in the body and the Co-Authored-By trailer