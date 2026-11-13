# Decision Record: Inspect scoped Handoff destinations and original native directories

Status: implemented

## Problem

The ordinary Runtime registry deliberately limits a member to its own registrations. A Session's execution owner still needs to select an eligible colleague's machine without receiving that colleague's complete registration. After preparation, the destination member also needs a safe directory caption before consent, including after a page reload; ordinary source options cannot authorize that read or replace the original target with a new default.

## Decision

`orgHandoff.targets` pages minimal destination metadata under the current Session's source execution owner and project execution access. It follows the existing project-participant and member/Hosted registration indexes, validates each canonical tuple and excludes the source. Private Sessions exclude other members. Each request scans at most four times its page limit and retains an empty page's continuation. Cursors bind the authenticated account, deployment, project, Session, source, binding epoch, control revision and share generation; every request reauthorizes current access. Ready, offline and incompatible are observations, not execution permissions. The general Runtime registry remains unchanged.

`orgHandoff.nativeTarget` authorizes only the original member destination of a preparing or prepared native Handoff with current Session/project access and no cancellation request. It signs the existing finite target inspection operation over that participant's actual connection. The returned Workspace ID, generation, catalog revision and project-selection revision must match the original mapping. A changed default is a conflict, not a replacement directory. Final authorization rechecks the Handoff phase, binding, mapping, control revision and live connection before returning the safe label with the original Handoff/mapping identities.

Both routes are reads. They allocate no resources, reserve no epoch, accept no target and create no execution permit. They retain the existing inspection signature domain and machine protocol. Generated SDK operations and mounted OpenAPI definitions are the client entry points.

## Alternatives considered

**Broaden ordinary Runtime registry access.** The picker needs a name, device identity and availability, not a colleague's full registration. Session-scoped authorization gives it only the required metadata.

**Repeat source options after preparation.** That read belongs to the source before a Handoff owns the Session. It cannot authorize a different destination member or identify an already reserved mapping.

**Display the current default directory or recreate a saved preparation.** Either can label a different physical selection as the old destination. The original references must still match; a read response cannot invent prior consent or clear an unknown mutation.

## Consequences

The destination must remain online with the current inspection protocol and original selection. Missing, changed or incompatible metadata leaves acceptance unavailable. Metadata does not start a machine or establish native transfer completeness. Web integration, Desktop IPC admission and final rendered interaction acceptance belong to their owning consumers.
