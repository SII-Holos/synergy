# Decision Record: Move organization conversations through existing handoff owners

Status: implemented

## Problem

Organization conversations have separate service reservation, native preparation, source surrender and destination activation owners. A Web move flow that guesses workspace references, retries an unknown mutation as a new request or starts execution after switching ownership can lose the original recovery state or act under another account.

## Decision

The conversation header opens a focused Move conversation dialog through the existing UI dialog owner. Runtime choices come from the generated paged directory API. Read-only handoff preflight supplies the actual source workspace, legal mapping choices, current binding epoch and control revision. Native mapping creates an independent private destination copy and retains source files; the inspected default destination folder is not presented as an overwrite or adoption target. Keeping organization storage uses its existing inspected reference without requiring another personal resource grant. Copying into organization storage requires an actually authorized resource, a dormant workspace and an explicit valid relative path, retaining their real generation and revision. Unsupported directory adoption and difference-dependent choices stay unavailable.

The current execution owner can prepare a new move, including a member driver who is not the conversation creator. Destination consent uses the service's `canAccept` and exact mapping hash and revision. Source and destination preparation, irreversible surrender, service commit and paused destination activation remain separate visible steps. Destructive cancellation and destination retirement use the existing confirmation component. The flow never starts a member runtime, requests compute or sends Continue; ordinary conversation controls retain the latter operation.

One versioned browser metadata record retains the original handoff and pending body under organization, account, deployment incarnation, project and conversation. Persistence succeeds before mutation. Unknown preparation is reconciled by its original handoff ID; unknown native operations are inspected through the same participant instead of replayed. A definitive owning `not_dispatched` service rejection can release that local pending intent and require fresh preflight. Native blocked operations retain their original request body for explicit recovery. A lost permit reply supports explicit retrieval of the same stored purpose; retrieval alone never surrenders or activates a runtime. Complete permits remain volatile. The service owner returns its retained permit before signing a new one, and the real owner fixture discards a committed reply and verifies one signing invocation across repeated recovery reads.

The canonical cancellation-request flag acknowledges only the service intent. Reading that flag after a lost reply retains the original handoff and paused ownership; a second explicit confirmation drives cancellation on the original source. It never substitutes for the native source-cancelled fact. A canonical surrender that wins the race retires the obsolete cancellation intent without reopening source execution.

An unknown or blocked native request does not hide cancellation. The same metadata record has an optional independent cancellation slot, restricted to the service intent or the original source-cancellation body. Acknowledging either slot preserves the other, and neither can change handoff identity while unresolved. Both service cancellation and native source cancellation require their own explicit confirmation. Unknown native cancellation is inspected; only a known blocked result offers an explicit retry with its original body. Signed permits and credentials remain outside both slots. Terminal canonical state can retire the complete record.

The metadata owner distinguishes a newly accepted cancellation from a retained request. A stale renderer confirmation that finds an existing unknown slot rehydrates and inspects it without another POST. New slots carry a local nonce: a first trusted service `not_dispatched` result can release only its matching service slot, preserving the native body and any later unknown cancellation. Older records without that nonce remain unknown and retained, without being upgraded into a new dispatch. This identity guard is not cross-renderer compare-and-swap or a claim of complete multi-tab linearizability; no separate ledger or global lock is introduced.

Cancellation advances a local observation generation, retiring older preparation responses, inspections and errors while preserving their original pending identity. This is a renderer lifetime guard rather than a service revision: the command sequence remains a source barrier and cannot order arbitrary handoff views. The source-cancellation result and preparation result have separate presentation state. Native cancellation may drain the original job even while its response is still outstanding; the UI does not infer native completion from a service flag or clear an unknown preparation to make room for cancellation.

Cancellation keeps its trigger node while changing its pending state and label. Confirmed actions restore focus to that connected, enabled trigger or the move dialog's stable Close control when the action removed or disabled it. This restoration requires the original Space, handoff and active parent dialog; another owner's dialog must retain focus. Real keyboard and Chinese narrow-layout cases assert focus stays inside the owning move dialog after both confirmation steps.

Every request, callback and dialog retains its original Space view and account authority. Navigation, incarnation changes, account revocation and disposal invalidate old responses. Changes in execution permission close only this move owner's confirmations. Workspace selector epochs reject late responses after another resource selection, including a return to the first resource. Completed and cancelled moves refresh the existing conversation reader and leave native work paused.

## Alternatives considered

**Treat moving as one optimistic request.** Native preparation and surrender can outlive a renderer or response. A single success assumption would lose recoverable partial progress and confuse service commit with activation.

**Use the target's default directory as an implicit adoption choice.** The existing native operation creates an independent copy. Adopting existing files requires its own difference review and native owner, so preflight metadata alone cannot enable it.

**Create another runtime or allocate execution resources automatically.** A selected destination is an existing connected owner. Starting processes or acquiring compute is a separate user decision.

**Discard an unknown operation when no visible row confirms it.** A finite history page or missing observation does not prove that the original operation failed. Recovery retains its ID and complete body until the owning result is known.

## Consequences

The UI reuses generated SDK calls, theme tokens, shared controls, localization descriptors and the existing dialog and Space lifetimes. The focused browser fixtures use isolated synthetic services and headless Chromium; they do not establish a real cross-device transfer or full organization acceptance. Native and keep-cloud flows, durable response loss, explicit permit retrieval, resource selection, revocation, keyboard behavior and narrow geometry remain independently verifiable. Catalog extraction and translations belong to the shared localization owner.

The browser-rendered component and static message table use exact coverage-manifest entries tied to the rendered scenarios and localization checks. Pure pending-state and outcome helpers remain directly measured; complete package coverage retains the ordinary gate.

The cancellation regression first reaches a real rendered nonrecoverable native requirement and then fails because its Cancel move entry is absent. Its synthetic service fixture controls lost service and native cancellation replies across reload, a delayed original native reply, and a canonical surrender that wins before cancellation. These establish renderer coordination against the generated API; they do not substitute for a real multi-runtime native race or change archived-project authorization.
