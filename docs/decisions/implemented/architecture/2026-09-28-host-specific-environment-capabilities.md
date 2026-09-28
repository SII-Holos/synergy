# Decision Record: Declare host-specific Environment capabilities honestly

Status: implemented

## Problem

Selecting remote compute must not send a Browser, Computer or Git worktree action to the control plane's local host. A previous Browser page must also lose authority when its Session selects another Environment.

## Decision

Session Browser and Computer operations require the native Environment before contacting their existing hosts. Computer dispatch holds the Session binding. Environment changes run the registered resource transitions before committing, so Browser page closure has the same acknowledgement and retry behavior as Workspace changes. Native and WebRTC remain Browser presentation modes, independent of compute placement.

Managed worktree creation and entry require a native Session Environment and native directory context. Preparation callbacks used by native worktree management cannot execute on the controller for a remote command. Ordinary remote Git commands continue through Bash and the selected Executor.

## Alternatives considered

Inferring Browser or Computer support from remote process execution would claim a host that the Docker provider does not implement. Falling back to the controller would change the command's target. Adding a remote desktop implementation would expand this delivery beyond its selected execution provider.

## Consequences

Unsupported capabilities fail explicitly before side effects. Existing native Browser and Computer implementations retain their ownership and presentation rules. Tests cover old-page closure, remote and absent selections, no allocation during capability rejection, and worktree rejection before controller filesystem changes.
