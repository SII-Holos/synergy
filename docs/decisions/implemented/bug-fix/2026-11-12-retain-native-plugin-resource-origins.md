# Decision Record: Retain native Plugin resource origins

Status: implemented

## Problem

Plugin Host Services selected Workspace and execution resources without mandatory native provenance. Supplying a generic Plugin Host for every call would also replace Agent Tool authority when a tool defers its Workspace requirements until a Host callback.

## Decision

Plugin startup registers the native Plugin Host origin before Runtime startup. The private invocation context captures an inherited opaque origin and its Scope/Session binding before asynchronous preparation. Missing provenance in a present frame fails closed. Only an absent frame can select the registered Host. Existing Manager async-context snapshots restore that private origin for process Host callbacks and retain pending work through drainage.

The Agent Tool source captures the original native context, reads the canonical assistant root and uses the current native Run, full registered tool ID and call identity. The existing Environment origin authority verifies that tuple before plugin preparation. Tools with `requiresWorkspace: false` retain the same private provenance for later file or shell Host calls. No resource authority derives from actor labels, optional user-message metadata or a fabricated call identifier.

Resource preparation checks the original admission before native claims and again through the existing resource owner. A paused Task cannot start another effect, while an independently initiated UI invocation can use its registered Host without reviving that Task.

One native Tool origin may produce several physical shell calls. Each Host callback receives one operation ID issued by its current private Environment resource frame; sandbox preparation and execution use that same ID. The frame binds issuance to its original resolved resources and Runtime, closes on body settlement, and discards issued IDs. Fabricated IDs, another resource object, and callbacks escaping that frame cannot reuse this authority. Ordinary Bash keeps its existing base operation identity. Canonical native preparation, execution, Use, saving and receipt owners remain unchanged; no new ledger or Plugin wire field is introduced.

## Alternatives considered

**Use the Plugin Host for every callback.** A real process test read the requested bytes while incorrectly recording an Agent Tool as a Host invocation. This loses the original Task's admission fence.

**Build provenance from the actor sent to the plugin.** Those fields are presentation metadata. The host's canonical message, Run and tool records supply the authoritative identity.

**Transmit native capabilities in the plugin protocol.** Existing host-side async-context restoration retains the opaque capability without exposing it to plugin code or revising API 4.

## Consequences

The host-only invocation and Tool adapters carry provenance; public Plugin definitions and IPC envelopes are unchanged. Minimal native fixtures compose Plugin startup explicitly. Docker execution remains an opt-in integration check.

## Verification

`packages/plugin-host/test/plugin-runtime/workspace-origin.test.ts` exercises the real Tool source, process runtime, Host IPC and storage-backed file reader with canonical Session/root/Run/tool evidence. It checks inherited identity, a missing frame origin, another Session, missing and forged call identifiers, paused Task refusal and independent UI access. Workspace context/Environment, tool invocation and shell Host Service suites retain saving, cancellation and pending-work drainage checks. See [the postmortem](../../../postmortem/0130-plugin-host-callback-lost-its-native-task-origin.md).

`packages/plugin-host/test/plugin-runtime/agent-shell-sequence.test.ts` runs two real shell processes through one process Plugin Tool and one canonical Run/call. It verifies distinct completed native executions with the same original origin, both file effects, released Uses, and rejection of fabricated, cross-resource and escaped-frame child identities. The pre-fix second call failed because it reused the first call's closed preparation. Existing native preparation and Bash tests retain their base-ID, background-saving and paused-admission checks.
