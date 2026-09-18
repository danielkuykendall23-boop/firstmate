# Vendored: tamaratran/fast-jev-compaction

`src/` is a verbatim copy of the upstream project's own `src/` directory (its harness-agnostic npm library, not the Claude Code-only `hooks/` plugin), with one mechanical, fully-enumerated patch applied.

- Source: <https://github.com/tamaratran/fast-jev-compaction>
- Pinned commit: `e3f262a7f4d42bd8dd32ced30d26176f7cb545b0`
- License: MIT (`LICENSE` in this directory, copied unmodified)
- Pinned source archive: `tamaratran--fast-jev-compaction-e3f262a7f4d4.tar.gz`, sha256 `4b1de046ee17f93079968c0865a12bf94fa264f007b2527c0a11eb6794550e77`
- Vendored: 2026-09-18

## The one patch

Every internal relative import in `src/*.ts` used a `.js` extension pointing at a sibling `.ts` file (`from './request.js'`), the standard TypeScript-ESM convention their own bundler (`tsc`) resolves.
Node's native TypeScript support - the same loader omp's own `.omp/extensions/*.ts` discovery uses, with no separate bundler step - does not remap `.js` imports to `.ts` files.
Verified before patching: `node --input-type=module -e "import '.../compact.ts'"` failed with `ERR_MODULE_NOT_FOUND` for `request.js`.

The only change from the pinned upstream bytes is `s/from '\.\/\([a-z]*\)\.js'/from '.\/\1.ts'/g` applied to each vendored file's own relative imports (`client.ts`, `compact.ts`, `index.ts`, `messages.ts`, `request.ts`, `state.ts`).
No algorithm, constant, type, or exported behavior was changed.
Diff the pinned archive's `src/` against this directory to confirm: every line differs only in that one substring, on the lines listed by `grep -n "from '\./" src/*.ts` in each file.

## What is not vendored

`hooks/`, `.claude-plugin/`, `tests/`, `demo/`, and `examples/` are not copied here: they are Claude Code-specific, or upstream's own test/demo assets that this repository's own `tests/fm-jev-compaction.node.test.ts` does not need to duplicate.
`.omp/extensions/fm-jev-compaction.ts` is the omp-side adapter that calls this vendored library; it is not part of the vendored copy and is not upstream's code.
