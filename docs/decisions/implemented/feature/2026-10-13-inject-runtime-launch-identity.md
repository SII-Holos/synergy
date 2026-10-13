# Decision Record: Inject hosting Runtime identity without rewriting the cache prefix

Status: implemented

## Problem

The Agent's environment context describes its Session Workspace and selected execution Environment, but neither identifies the Synergy backend carrying the conversation. During self-development, source Web, external Desktop, managed Desktop, installed services and one-shot tasks can use different source checkouts, Homes and ports. Inferring the host from edited files or a default port can target the active Runtime instead of an isolated development instance. Moving host facts into an early system message would also rewrite reusable provider prefixes.

## Decision

Runtime Host carries typed launch provenance. Development process plans register their owning entrypoints, Desktop registers managed ownership, and actual CLI handlers provide server or send defaults. Daemon ownership and installed-generation metadata take precedence over inherited development labels. Local source hosts capture the checkout containing their implementation and its Git revision once at creation. Runtime instances retain their own ID, start time and mode; listener facts come from the existing Runtime-owned endpoint state after binding, including ephemeral ports. Missing provenance or listeners remain explicit. No raw argv, arbitrary environment variables or credentials enter the identity projection.

SessionInvoke renders the identity as the named `synergy-runtime` advisory source at one fixed position: after tool intent and attachment guidance, before recall and Session environment. Stable system messages and their cache breakpoint do not change. The existing [durable advisory mechanism](../architecture/2026-10-11-durable-advisory-context.md) retains the first Codex observation in conversation order, omits unchanged identity from continuations, and appends a complete new observation when the Runtime changes. Other provider layouts retain the same fixed advisory ordering without changing provider cache policy. An attached client cannot relabel the backend, and the backend identity does not grant filesystem or execution authority.

## Alternatives considered

**Put identity in the system prefix.** Even stable per-instance values vary across restarts and deployments; inserting them ahead of history would alter existing cache prefixes and instruction precedence.

**Append a fresh identity on every model step.** It duplicates unchanged data and defeats the existing source-revision deduplication. Start time, revision and instance ID are snapshots, not per-request samples.

**Infer the host from Workspace, channel or ports.** Workspaces identify edited files, dev channels can contain packaged applications, and port zero or conflicts can change the listener. Actual owners and listener state are authoritative.

**Create a separate instance registry or inspector tool.** The Host, Runtime context and endpoint state already own these facts. A parallel registry adds synchronization and lifecycle failure modes without improving model visibility.

## Consequences

The Agent can distinguish the active backend from an isolated development target while preserving prompt order. Identity adds a bounded set of complete host facts to the initial context, and a restart legitimately appends new historical facts rather than rewriting old observations. Source Git probing occurs only when a local source Host is created; unavailable revision evidence is omitted instead of guessed. A source snapshot is the revision at launch, not proof that later file edits have been loaded. Existing uninstrumented or custom hosts retain explicit unknown provenance.

Tests exercise actual SDK prompts for Codex, OpenAI and Anthropic, unchanged system messages, the complete previous Codex request as a prefix of its continuation, no repeated unchanged identity, Runtime isolation, actual ephemeral HTTP listeners, same-Home restart, source provenance and startup-plan ownership. These establish deterministic layout and lifecycle behavior, not a measured provider cache-hit percentage. Packaged native application acceptance and real-provider cache measurements remain separate checks.
