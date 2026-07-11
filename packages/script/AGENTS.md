# Build Script Package Rules

This package owns shared build and release utilities consumed by repository scripts.

- Keep the root-pinned Bun version check, release channel/version derivation, registry checks, and retry behavior explicit. Do not perform publication merely by importing a helper.
- Treat branch names, release environment variables, timestamps, and network registry responses as external inputs. Validate them and keep preview versus latest behavior deterministic.
- Do not embed credentials, local paths, or private endpoints in output. Publication and version changes require explicit user authority and the release workflow.
- Keep helpers reusable by repository scripts without importing product runtime state.

Run the consuming build/release script tests, root `bun run package:check`, and `bun run quality:quick`. Read [Desktop release](../../docs/operations/desktop-release.md) and the release workflow before changing version or publication behavior.
