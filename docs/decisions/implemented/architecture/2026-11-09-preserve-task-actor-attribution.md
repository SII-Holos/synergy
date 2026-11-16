# Decision Record: Preserve task actor attribution

Status: implemented

## Problem

A durable input can wait in Inbox while identities or active clients change. A task can then consume another author's supplement before executing a tool. Inferring its operator from the current login or latest message loses the original attribution and makes retries appear to have a different author.

## Decision

The portable `ActorStamp` schema lives in Util so protocols and UI can consume it without loading an execution Runtime. Harness exposes it through `context` and owns propagation through Inbox, canonical message headers and Tool contexts. Account, local and system subjects remain distinct; an account stamp requires its organization, and system stamps can retain a bounded trigger chain. Stamps record identity evidence rather than roles or authorization.

Trusted hosts pass the actor separately from ordinary public `InvokeInput`. Admission captures a validated copy before awaiting other work. Materialization and duplicate delivery retain that original value. A newly written assistant takes the recorded actor of its explicit task root, and each Tool receives a copy. Existing message attribution is immutable, including absence. Forks retain historical stamps while remapping message IDs.

The new fields are optional and do not reinterpret existing values. No migration rewrites historical data or creates attribution for old personal inputs. Stored stamps remain with their existing message/Inbox owner and deletion lifecycle.

## Alternatives considered

**Use the current login or latest user message.** Both can change while an accepted input is waiting or executing, and a collaborator's supplement does not become the initiating actor of every subsequent tool.

**Accept actor fields in public input bodies.** This allows a client to choose another account's identity. Hosts must establish trusted identity before passing it to the persistence owner.

**Define a second actor schema inside the organization protocol.** It would diverge from generic execution and force consumers to translate attribution. A portable common schema preserves one representation without importing organization roles into Harness.

## Consequences

Message and Inbox response schemas expose optional attribution, requiring generated client updates. Canonical message writes read the existing header and, for a new assistant, its root to retain attribution. Actor stamps do not grant access or authorize execution; those decisions remain with the host. Historical unknown actors remain unknown. Behavioral tests cover duplicate input, mutation, separate collaborators, rollback, restart, fork and actual tool execution.
