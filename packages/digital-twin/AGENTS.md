# Digital Twin

Own optional next-input inference, historical evidence selection, quantitative voice sketches, lifecycle, configuration and the HTTP adapter. Read the root rules and Session architecture before changes.

- Depend only on public Harness and shared utility boundaries. Keep the Server dependency optional and in the HTTP adapter. Core must not register this Agent or start preparation.
- Use `AgentCall.text` with independent operation ownership, the explicitly selected model and schema-only output. Do not create Sessions, execute tools, add a provider client or generate a prose identity profile.
- Canonical history is authoritative. Persist only versioned references, numeric features and resumable checkpoints in central Storage. Selected source edits and deletions invalidate inference; unrelated corpus catch-up does not.
- Exclude assisted, generated, external-author, system, artifact and secret-bearing text from positive voice examples. Preserve complete current context and coherent optional examples.
- Start preparation on use, honor existing background health/pause controls, and abort/drain owned work on close. Workers register configuration and the hidden Agent only.
- Keep the two settings and the existing composer insert/send boundary. Evaluation uses immutable historical evidence, temporal exclusion, actual model outputs and independent blinded judgment; private transcripts and credentials never enter Git.

Run `bun test test`, `bun run typecheck`, affected Harness/composer tests, package checks and SDK generation after public schema changes. The offline `script/evaluate.ts` entry is opt-in and uses an isolated Home with real provider configuration; it does not run in CI.
