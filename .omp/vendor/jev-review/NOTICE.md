# Vendored: NiazMorshed2007/jev-review

- Source: <https://github.com/NiazMorshed2007/jev-review>
- Pinned commit: `57690af54ef7d862c2483342c1e61c14dffcf727`
- License: MIT (`LICENSE`, unchanged)
- Pinned source archive sha256: `d5e5988f4f925efb6cc869c87f188b72ee4e4d9289e24234b72cb20c16d5d854`
- Source vendored: 2026-09-22

## Scope and patches

`src/config`, `src/evaluation`, and `src/jev` are byte-for-byte upstream source.
No import-extension or credential patch is needed: esbuild resolves upstream `.js` specifiers to its `.ts` sources, and upstream already accepts an explicit `apiKey` and injected client.
`index.ts` is the Firstmate-authored transport-free export surface.
`package.json` retains upstream's version and exact Zod/esbuild versions, removes the unused MCP dependency, and replaces the build command with the evaluator-only bundle.
`dist/review.js` is generated from that entry with Zod 4.6.5 included, not a reimplementation of evaluation logic.
`dist/review.d.ts` exposes the corresponding upstream types.
The old server bundle is removed; no MCP client, subprocess, or user-scope installation is used.
The OMP adapter owns key resolution, native secret-protection refusal, the local fake-endpoint fetch seam and sanitized fallback messages.

## Dependency notice and reproducibility

Zod 4.6.5 is MIT-licensed; `LICENSE.zod` is its unmodified license.
Its npm archive is <https://registry.npmjs.org/zod/-/zod-4.6.5.tgz>, integrity `sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==`.
From this directory, install the exact development dependencies from `package.json`, then run `npm run build`.
The build is `esbuild index.ts --bundle --platform=node --format=esm --target=node20 --outfile=dist/review.js` with esbuild 0.28.2.
No runtime dependency installation is necessary because the bundle is committed.
