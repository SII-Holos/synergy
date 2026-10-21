# Digital Twin

Optional next-user-message prediction. The public component registers configuration, a hidden Agent and lazy preparation; the separate HTTP adapter contributes `POST /digital-twin/predict-next-input` and the `digital-twin` capability. `service` exposes independent recorded prediction and shutdown, and `contract` exposes validated request, result and settings schemas.

Full installations select this component. Core does not. Digital Twin depends on public Harness corpus/context APIs and Local Runtime, without a Library dependency. Configuration belongs to `35-digital-twin.jsonc`: `automatic` defaults to true and a null or absent `model` follows the current Session. No profile, training or source-selection setup is required.

The composer shows a suggestion only after a successful completed root and on an eligible empty draft. Tab inserts it, Escape dismisses it, and sending remains explicit. Manual prediction is available when automatic prediction is disabled. Accepted suggestions retain generic assistance metadata so subsequent predictions do not treat them as original voice.

See the [decision record](../../docs/decisions/implemented/feature/2026-10-21-digital-twin-next-input.md) for ownership, provenance and quality constraints. Run focused tests with `bun test test` and type checking with `bun run typecheck`.

Run the optional offline evaluation against an isolated copy with `bun packages/digital-twin/script/evaluate.ts --home <isolated-parent> --output <private-directory> --model <provider/model> --judge <provider/model>`. It uses the configured provider infrastructure and makes paid model calls. Keep its private reports outside the repository.

The evaluator visits every eligible immutable historical continuation, freezes predictability before generating candidates, and compares context, voice and full recipes under identical generation settings. It excludes unverified history and preserves failed calls separately from abstention. Source, corpus and model configuration hashes identify an experiment; each dispatched recipe is saved before invocation and after completion. Resuming never replaces an already dispatched sample. Reports include all cases, supplied evidence, category coverage, errors, paired uncertainty and provider receipts; absent usage fields stay unknown. The default batch has four independent cases after the first case, using normal model admission.
