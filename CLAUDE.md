# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

pi-oven is an npm-workspaces monorepo of extension packages for the [pi coding agent](https://pi.dev). Each package under `packages/` is published to npm independently; this repo is the shared development hub. READMEs, code comments, and the PR template are written in Korean — keep that convention when editing them.

Current packages:

- `pi-ui-kit` — interactive terminal UI tools (`ask_user`, `ask_text`, `notify_os`) plus the Pai mascot session header
- `pi-hwp` — `read_hwp` tool: extracts text/tables from Korean HWP/HWPX documents (hand-written ZIP and CFB parsers)
- `pi-odt` — `read_odt` tool: extracts text/tables from OpenDocument `.odt` files (hand-written ZIP parser)

## Core principles (from the maintainer)

These override anything else in this file when they conflict:

1. **Use what Node supports natively, as-is.** If a Node builtin covers the need (`node:zlib`, `node:fs`, `node:child_process`, `node:os`, ...), use it directly — don't add an npm dependency for it and don't reimplement it by hand. Hand-written parsing (ZIP/CFB) exists only where Node has no builtin.
2. **Every review applies multiple rule sets, always including the ponytail review.** Ponytail (what changed / what was cut / what was actually verified / what was intentionally not built) is the baseline for every PR and self-review; layer the other repo rules on top of it — zero-dependency check, Korean doc convention, typecheck + `pi -e` load verification, screenshot for visible TUI changes.
3. **Develop pi-답게 — in pi's philosophy.** Small single-file extensions, no build step, zero runtime dependencies (pi supplies peers), tools that teach the agent via `promptGuidelines` instead of requiring user instruction, clear errors over partial output, and minimal TUI that respects `visibleWidth` and the theme. When in doubt, choose the smaller, more self-contained design.

## Commands

```bash
npm install                    # install workspace deps
npm run typecheck              # tsc --noEmit over packages/*/extensions/**/*.ts (strict)
npm test                       # node:test unit tests for the pi-hwp/pi-odt hand-written parsers
pi -e ./packages/<name>        # load a package into a local pi session without installing
```

There is **no build step** — pi loads the TypeScript sources directly — and no linter. `npm run typecheck` and `npm test` are the repo-wide automated checks; CI (`.github/workflows/typecheck.yml`) runs exactly `npm ci && npm run typecheck && npm test` on Node 22. The unit tests (`packages/pi-{hwp,odt}/test/unit.test.mjs`, plain `node --test` with `--experimental-strip-types`) assemble ZIP/CFB fixtures in code — no binary fixtures are committed. pi-db additionally has a real-database integration test (`node --experimental-strip-types packages/pi-db/test/integration.mjs` against dockerized MySQL 8.4 + Oracle Free 23; CI runs the same script via service containers in `.github/workflows/pi-db-integration.yml` when pi-db changes). Other behavioral verification is manual: load the package with `pi -e` and exercise the tool in a real session (against real `.hwp`/`.odt` files for the readers).

## Architecture

### How a pi package is shaped

Each `packages/<name>/` contains:

- `package.json` with `"type": "module"`, the keyword `"pi-package"`, and `"pi": { "extensions": ["./extensions"] }`. Pi dependencies (`@earendil-works/pi-coding-agent`, `pi-tui`, `pi-ai`, `typebox`) are declared as **peerDependencies** — pi supplies them at load time, so packages ship with zero runtime dependencies.
- `extensions/*.ts` — every `.ts` file in this directory is auto-loaded by pi. Each file default-exports `function (pi: ExtensionAPI)` and does one of two things:
  - **register a tool**: `pi.registerTool({ name, label, description, promptSnippet, promptGuidelines, parameters, execute })` with typebox `Type.Object` parameters. `promptGuidelines` is injected into the agent's system prompt, which is how the agent learns to prefer these tools (e.g. use `read_odt` instead of built-in read for `.odt`). `execute` returns `{ content: [{ type: "text", text }], details }`.
  - **hook an event**: e.g. `pi.on("session_start", ...)` — `pai.ts` uses this with `ctx.ui.setHeader(...)` to render the mascot banner.
- Each extension file starts with a header doc comment (Korean) explaining the format/UI it handles, including ASCII sketches for TUI components.

Adding a new package: create the directory with the manifest fields above plus `extensions/*.ts`, confirm `npm run typecheck` passes and `pi -e ./packages/<name>` loads, then add a row to the root README's Packages table.

### Conventions that matter

- **Zero dependencies in the document readers** (`pi-hwp`, `pi-odt`): ZIP/CFB parsing is implemented by hand in the extension file; decompression uses `node:zlib` (`inflateRawSync`). A pure-TS inflate was tried and deliberately reverted (see git history) — don't reintroduce one. Unsupported/encrypted/corrupt input (encrypted ZIP entries, CRC mismatches, cyclic CFB sector chains, CFB v4) is rejected with clear errors rather than partial output.
- **Replacing the hand-written parsers with open-source libraries was evaluated and declined (2026-07)**, with hands-on testing against real files. Reasons: the only ZIP candidate matching principle 1 (adm-zip — sole sync-API library using `node:zlib`) has a repeated CVE history; the only viable CFB library (SheetJS `cfb`) has been frozen on npm since 2022-04; fflate ships its own pure-JS inflate (conflicts with the revert above); and `pi install` auto-installs a package's dependencies onto every user's machine, so transitive deps are end-user attack surface. Don't re-litigate without new facts — re-evaluate if SheetJS resumes npm releases or `hwp-convert` (functionally strong, too young as of 2026-07) matures.
- Reader output is markdown-ish plain text: headings as `#`, table rows as `| cell | cell |`, output capped (e.g. 200k chars) with an explicit `[truncated ...]` marker.
- TUI components (`pi-ui-kit`) size everything by `visibleWidth` from `@earendil-works/pi-tui`; Pai mascot glyphs are all width 1 so they align inside any box. Theming: crust/border via `theme.fg("accent")`, steam via `theme.fg("dim")`.
- Older pi versions use the `@mariozechner/*` namespace instead of `@earendil-works/*` (and `@sinclair/typebox` instead of `typebox`); the current code targets `@earendil-works/*`.

## Pull requests

`.github/pull_request_template.md` enforces a "ponytail review" style (in Korean): state factually what changed per package/file, list duplication/over-engineering that was **cut** in the diff (write "없음" if none), list only verifications that were **actually run** (`npx tsc --noEmit`, `pi -e` load, real-file tests), note what was intentionally not built, and attach a real pi screenshot for any visible TUI change. Follow that spirit in commits too: no marketing language, don't claim untested behavior.
