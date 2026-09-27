# Decision Record: Independent Environment allocation identity

Status: implemented

## Problem

A conversation, working files and a compute allocation have different lifetimes. Treating their identities as interchangeable requires compute for conversations that only call business APIs, and permits a delayed response from an old allocation to affect its replacement.

## Decision

Harness owns a transactional Environment catalog and owner bindings independently of Workspace bindings. Creating an owner binding records the provider and specification without allocating compute. Concurrent acquisition shares one durable allocation intent. A target contains the logical Environment ID, allocation ID and execution generation. Workspace binding generations and content versions retain their own meanings.

Provider registration belongs to a Runtime and is sealed before startup. Providers allocate, inspect and deallocate resources; callers never substitute a native provider when the selected provider is unavailable. The allocation request identity is durable before calling the provider. An uncertain response is reconciled through inspection, without repeating allocation. Providers must identify allocations by the request identity and report absence only when it is authoritative.

Environment uses are durable records. Deallocation requires no outstanding uses and a confirmed provider response. Native providers own only their borrowed execution resources; they cannot stop the machine. Managed providers support idle reclamation independently of owner binding lifetime. Recovery reconciles the active-allocation index before admission and preserves uncertain uses.

The catalog uses the existing Agent Storage transactions. It does not introduce a second Session store or change PostgreSQL namespace ownership. Synergy Link is an independent capability and supplies neither Environment identity nor transport.

## Alternatives considered

**One container per conversation.** This couples conversation lifetime to resource cost even when no tool needs that resource.

**Reuse Workspace binding generation.** Moving files and replacing compute are independent events. One counter cannot identify both without invalidating unrelated resources or accepting stale execution.

**Retry after an allocation timeout.** A lost response is not evidence of failed allocation. Inspection by the persisted request identity preserves deduplication across Runtime restarts.

## Consequences

API-only work can retain owner bindings without compute. Direct input, durable inbox processing and model-loop entry do not require available files; file operations validate their selected Workspace when admitted. Prompt assembly reports an unavailable Workspace without substituting another path or blocking API work. Providers must support authoritative reconciliation and confirmed deallocation; providers lacking those guarantees fail closed. Unknown uses deliberately prevent automatic reclamation until their executor or an explicit recovery operation supplies physical completion evidence.

Web and Desktop select Environments independently from Workspaces through the working-location menu. Opening the chooser reads the catalog and existing activity without allocating compute. Selection uses the observed Session binding, creation retries retain the original request ID, and new-session recovery restores its explicit choice. Recovery targets existing operation IDs; release compares allocation generation and remains blocked by active uses.
