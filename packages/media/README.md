# Media

Document extraction, speech, audio and image processing capabilities.

Load heavy parsers and media workers through the owning feature. Register document text extraction explicitly and preserve processing errors and cancellation.

Cross-package imports use the explicit entries in `package.json`. Tests and fixtures belong in this package’s `test/` tree. Full API composition tests belong in `product-runtime/test/`.

Run `bun run typecheck`, `bun run test`, and `bun run test:coverage` from this package. Build an importable library with `bun script/build-workspace.ts packages/media` from the repository root; `bun script/pack-workspace.ts packages/media .artifacts/packages` builds its workspace dependency closure.
