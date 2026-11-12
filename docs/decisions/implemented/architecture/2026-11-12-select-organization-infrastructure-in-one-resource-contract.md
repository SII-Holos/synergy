# Decision Record: Select organization infrastructure in one resource contract

Status: implemented

## Problem

The Session resource contract selected only a model and business connections. Cloud Workspace and Environment catalogs already had canonical resource ownership, but selecting their IDs separately would permit inconsistent authorization, resource accounting and handoff revisions. Treating every resource after the model as a connection would also expose infrastructure through the business gateway. Native preparation ignored these selections and could continue through local defaults.

## Decision

`Execution.Selection` requires one explicit infrastructure facet. Its Workspace reference contains an organization resource ID and cloud Workspace ID; its Environment reference contains a resource ID and cloud Environment ID. Each slot is either that complete reference or explicit null. The public schema accepts no native paths or implicit defaults. Resource identities remain unique across all roles. Accounting includes infrastructure; model/connection descriptions and gateway capabilities use only their explicit business roles.

`OrganizationSessionResources` remains the single selection and revision owner. The same authorized transaction validates selected resource roles, canonical cloud locators and native catalog ownership before publishing the selection, directory resource IDs and directory revision. Task admission and binding recheck object ownership and availability without rechecking the original selector's private resource grants against a collaborator. Selection performs no allocation or file transfer.

Stored contracts use schema two and execution grants use schema five. The owning record-access migration projects strict legacy contract-one and grant-four selections into explicit null infrastructure, preserving revisions, actor, accepted input, retention, grant identities and original stored bytes. Older grant upgrade steps validate their own strict schemas before reaching the current reader. Unknown versions or malformed legacy shapes fail. Native portability reader three carries command/grant identifiers and bodyless housekeeping references, not grant bodies, so this change does not reinterpret its transport records. Grant readers verify schema five at the resource response boundary.

The native execution source rejects non-null organization infrastructure until a real cloud mapping owner supplies the execution integration. The guard precedes native model selection and materialization; direct business and worker preparation use the same boundary before invocation. The accepted Inbox item remains intact, no Run is created and no compute is allocated. This source unit establishes selection and authorization, not cloud execution or handoff mapping consent. Main handoff capability remains disabled while those owners are incomplete.

## Alternatives considered

**A separate infrastructure selection record and revision.** This would create two authorities for one Session resource choice and allow model or handoff decisions to observe incompatible versions.

**Reuse the business connection list.** Infrastructure has different canonical object ownership and execution semantics. Positional classification could produce a business capability for storage or compute.

**Default missing public facets to null.** An old or incomplete client could silently replace a cloud selection with native defaults. Only the explicit owning legacy migration introduces null values.

**Continue through local resources while cloud execution is unfinished.** That changes the requested execution location and may expose Runtime storage. The native boundary reports unavailable mapping and retains the queued work instead.

## Consequences

Clients must preserve the returned infrastructure facet when editing models or connections and send explicit null slots for a new native selection. Current generated SDK contracts expose the required shape. Model credentials and private infrastructure profiles remain service-owned. Source/target mapping consent, resource-selection actor attribution, cloud operation provenance and physical drainage are separate required work; this contract does not substitute for them. Protocol, service, migration and enrolled HTTPS/native Inbox tests cover the boundaries.
