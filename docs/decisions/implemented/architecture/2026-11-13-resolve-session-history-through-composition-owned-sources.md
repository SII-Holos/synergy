# Decision Record: Resolve Session history through composition-owned sources

Status: implemented

## Problem

The generic Session reader can access every native history in its Runtime. An application hosting separate principals needs to authorize target access before lookup and may own a projected history outside the native Store. Tool permission approval alone cannot supply that application ownership.

## Decision

Harness exposes `SessionReadSource` as a Runtime-scoped composition port. A source resolves a detached caller/target window and the original cancellation signal into either native reading or an application-owned projected result. Registration seals with composition and is independent between Runtime instances.

Local Runtime consults the source before requiring the target Session or hydrating its history. Native reading remains the only personal implementation. A registered denial, cancellation or invalid result propagates; it never falls back to local storage. Projected results do not require a locally stored target.

## Alternatives considered

**Put organization authorization in the generic Session manager.** The manager owns native data, while applications own principals, projections and current target authorization. Importing an application owner would invert the package dependency.

**Authorize after target hydration.** The denied body may already enter metadata, logging or a model-facing result. Resolution must precede every target body read.

**Return native content when a source is unavailable.** Temporary owner failure would become a privilege expansion. Only a composition with no registered source retains the generic native behavior.

## Consequences

Applications can provide target-specific access without a second native reader. Personal behavior stays independent of application availability. A host must register the source in every worker composition that exposes this tool and must implement its own target authority; the generic port grants none.
