# Migration Notes

This directory documents host-data migrations and explicit clean breaks that still affect Synergy users. It is not the source of truth for current plugin authoring.

- [Plugin API 4](plugin-api-4.md) — explains the API 4 runtime, approval, contribution-health, trusted UI, and package-export clean break.
- [Plugin API 3](plugin-api.md) — explains the earlier API 3 descriptor/runtime clean break and host catalog migration.
- [GitHub webhook to polling](github-webhook-to-polling.md) — replaces the inbound GitHub webhook API and secret with outbound GitHub App REST polling.
- [Synergy Link rebrand](synergy-link-rebrand.md) — renames MetaSynergy protocol and package identifiers to Synergy Link v2.
- [Lattice v2 reset](lattice-v2-reset.md) — removes incompatible Lattice v1 run and event records while preserving authored Blueprint Notes.

For current product and developer behavior, start at [Documentation](../README.md).
