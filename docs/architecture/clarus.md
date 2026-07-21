# Clarus Channel provider

Clarus is implemented as a Channel provider. It uses the authenticated Holos Agent Tunnel for transport, but connection lifecycle, reconnects, inbound message routing, and outbound responses are owned by the existing Channel runtime.

## Project ownership

An external Clarus project maps to one real Synergy Project Scope:

```text
Clarus project
  -> Channel project-scope binding
  -> Scope.Project
  -> ordinary Sessions in that Scope
```

`Channel.ensureProjectScope({ channelType, accountId, projectID, projectName })` creates or restores a workspace under `data/channel/workspaces/<identityHash>/workspace` and registers it through `Scope.fromDirectory()`. The binding at `data/channel/project_scopes/<identityHash>` contains only `projectID` and `scopeID`. Scope remains authoritative for the directory, display name, archive state, and timestamps.

Identity hashes include the Channel type, account ID, and project ID. Raw external identifiers are not used as filesystem segments or lock names. A binding cannot be rebound to a different Scope during normal operation.

Project discovery creates or updates a normal Channel endpoint whose `chatId` is the Clarus project ID. Project rename updates the Scope name and endpoint chat name without overwriting a user-edited Session title. Project deactivation archives the Scope; it does not delete the workspace, binding, or Sessions.

## Session ownership

Project conversation uses an ordinary Channel Session in the project Scope. Clarus does not define a Session endpoint kind, Session category, navigation schema, or Session fields.

Endpoint lookup keeps the standard global indexes:

```text
endpoint_session/<endpointKey>/<sessionID> -> { scopeID }
session_index/<sessionID>                 -> { scopeID }
sessions/<scopeID>/<sessionID>/info       -> Session.Info
```

`Session.findForEndpoint()`, `Session.getOrCreateForEndpoint()`, and `Session.archiveForEndpoint()` require the resolved Scope. They resolve the endpoint globally and then verify `session.scope.id === scope.id`. A mismatch raises `Session.EndpointScopeMismatchError`; it never moves, reuses, or duplicates the Session in another Scope.

Endpoint creation and archive share a lock derived from the endpoint key. An endpoint may retain archived historical Sessions but has at most one active Session.

## Assignment ownership

Clarus assignments are provider-private protocol state. An assignment record stores its external lifecycle fields and one ordinary `sessionID`; it does not copy `scopeID`, workspace paths, or Clarus data into Session.

The provider resolves the project Scope, reuses the recorded Session when it still exists in that Scope, or creates a new autonomous unattended Session in that Scope. Assignment delivery uses `SessionInbox.deliverUnique()` with a stable remote identity.

`clarus_submit_task_result` resolves its assignment only from the current `sessionID`. It is deferred through normal tool search and explicitly rejects non-assignment Sessions. Result payloads are persisted in the provider outbox before tunnel dispatch. A definite `not_dispatched` result may be resubmitted with a new request ID; acknowledged, rejected, ambiguous, and crash-recovered pending results cannot be automatically resent. The assignment record and result outbox are reconciled during provider reconnect.

Provider-private state lives under:

```text
data/channel/providers/clarus/accounts/<accountHash>/
  sync/
  assignments/
  assignment_session_index/
  dedup/
  outbox/
```

Outbound project messages are written to the provider outbox before tunnel dispatch. Acknowledged records are retained for correlation. A definite `not_dispatched` failure may retry with a new request ID during reconnect; rejected and ambiguous records require intervention and are never automatically resent. A record still marked pending after process loss is conservatively changed to ambiguous during recovery.

## Transport boundary

The bounded Clarus wire parser, semantic event types, project REST parser, and Agent Tunnel adapter live in `packages/synergy/src/channel/provider/clarus/`. Snake-case wire fields are converted to `agentID`, `projectID`, `taskID`, `messageID`, `sessionID`, and `scopeID` at that boundary.

The provider registers through `Channel.registerProvider()`. Channel's `AbortSignal` removes event and connection observers. Holos credentials are read from the existing Holos credential store; tokens are not copied into Channel configuration.

## Product surface

Clarus projects appear in the standard Scope list. Project conversations and assignment work appear as ordinary Sessions inside the project Scope and use the standard Session page, composer, history, permissions, completion notices, and navigation.

There are no Clarus-specific Server routes, SDK operations, EventSource, App context, sidebar section, panel, route, or navigation category.
