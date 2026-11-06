# Decision Record: Atlas primary and text replacement as the code defaults

Status: implemented

## Problem

Fresh unconfigured scopes currently select the lightweight Pico primary and patch-based file interface, while the product's general assistant and text replacement interface are the intended default starting points for ordinary work.

## Decision

The code defaults `default_agent` to Atlas and `fileToolGroup` to replace, including the Web settings fallback, resolved Harness configuration, invalid-default Agent fallback, Agent catalog ordering and tool registry fallback. Explicit global, project, Session and composer selections remain authoritative and are not rewritten.

Atlas remains the fallback when a configured default is missing, hidden, disabled or subagent-only; another visible primary is used only when Atlas is unavailable. Text replacement remains a Scope-level interface selection independent of Agent identity, model, workflow and permissions.

## Alternatives considered

**Keep Pico and patch as the defaults.** Rejected because the fresh product entry point would continue to favor the lightweight execution profile and patch syntax rather than the requested general assistant and text replacement workflow.

**Write Atlas or replace into existing configuration and Sessions.** Rejected because a default change must not overwrite explicit user choices or change the tool interface of existing work.

**Change only the Web settings fallback.** Rejected because the composer, implicit backend execution, catalog ordering and tool registration would disagree across entrypoints.

## Consequences

Fresh unconfigured scopes present Atlas as the default Agent and expose the text replacement file interface. Existing explicit configuration remains unchanged, and a project override continues to take precedence over the global default. Tests cover the Web draft defaults, Harness resolution, invalid Agent defaults, unavailable Atlas fallback and explicit patch selection.

This supersedes the [lightweight primary default](../../archived/feature/2026-10-16-lightweight-primary-default.md) and the [independent scoped file interfaces](../../archived/architecture/2026-10-15-independent-file-tool-groups.md) only for their fallback choices; their configuration ownership, eligibility, permission and interface-separation rules remain applicable.
