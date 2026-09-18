# Vendored: NiazMorshed2007/jev-review

`dist/server.js` is upstream's own built MCP server bundle, copied verbatim from the pinned release archive, not rebuilt from source.
Upstream ships this exact file in its own repository (produced by their `npm run build`, an `esbuild --bundle` of `src/server.ts` plus its `@modelcontextprotocol/sdk` and `zod` dependencies), so vendoring the bundle is vendoring their own build artifact, not a repackaging.

- Source: <https://github.com/NiazMorshed2007/jev-review>
- Pinned commit: `57690af54ef7d862c2483342c1e61c14dffcf727`
- License: MIT (`LICENSE` in this directory, copied unmodified)
- Pinned source archive: `NiazMorshed2007--jev-review-57690af54ef7.tar.gz`, sha256 `d5e5988f4f925efb6cc869c87f188b72ee4e4d9289e24234b72cb20c16d5d854`, listed in `/Users/danielkuykendall/.agent-reach/downloads/jev-assessment-20260918/manifest.json`
- Vendored: 2026-09-18, as part of `data/env-jev-repo-integration/`

## What is vendored and why

Only `dist/server.js` (the built stdio MCP server, unmodified) and `package.json` (upstream's own metadata, unmodified, kept for the pinned version and dependency record) are copied here.
`src/`, `test/`, `skills/`, `.claude-plugin/`, `.codex-plugin/`, and `public/` are not copied: they are upstream's own TypeScript sources, tests, and Claude/Codex-specific plugin scaffolding this repository does not build or need.
`bin/fm-jev-review-setup.sh` is the omp-side installer that registers this vendored server in a user-scope `mcp.json`; it is not part of the vendored copy and is not upstream's code.

## No modification

No byte of `dist/server.js` or `package.json` was changed from the pinned archive.
Diff this directory against the pinned archive's `dist/server.js` and `package.json` to confirm.
