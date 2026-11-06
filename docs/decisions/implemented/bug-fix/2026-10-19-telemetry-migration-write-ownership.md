# Decision Record: Reserve telemetry migration write ownership before inspection

Status: implemented

## Problem

Telemetry migrations inspect existing schemas or rows before updating them and publishing schema metadata. A deferred SQLite WAL transaction can retain a read snapshot while another connection commits, making its later write fail with `SQLITE_BUSY_SNAPSHOT`. A busy timeout cannot repair that stale snapshot. Data transfer maintenance can encounter this ordering when telemetry from its caller is still draining.

## Decision

The observability domain runs its migration transactions with immediate write admission. Schema inspection, row transformation and metadata publication share that write ownership. Existing connection timeouts, atomic rollback and the central migration completion ledger remain unchanged; no migration identifier or persisted format changes.

The ordering follows SQLite's [isolation guidance](https://www.sqlite.org/isolation.html) and [transaction modes](https://www.sqlite.org/lang_transaction.html). A regression uses two real connections to attempt a competing write after schema inspection, verifies successful migration publication, and verifies that the competing writer can commit after the migration releases ownership.

## Alternatives considered

**Increase the busy timeout.** A stale WAL snapshot cannot be promoted by waiting, so a longer timeout does not resolve this ordering.

**Retry the entire migration or stop telemetry in the test.** Retrying can repeat progress callbacks, while suppressing the competing writer only hides the unsafe read-to-write transition. Immediate admission reserves the required resource before inspection.

## Consequences

Competing writers wait or receive the existing busy error at admission instead of invalidating an in-progress migration snapshot. Migration transactions hold write ownership during their reads as well as writes. They remain synchronous and atomic, and permanent failures still propagate without publishing central completion.
