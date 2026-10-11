# Decision Record: Plugin-owned discovery with Host-owned pairing

Status: implemented

## Problem

Manual Session transfer needs a usable destination selector across different networks. A network plugin can discover reachable computers, but discovery alone cannot authorize task or file access. Forwarding an entire local listener makes the network ACL the sole application admission boundary and may require sharing a managed-server credential.

## Decision

UI API6 compilation retains its historical 3.x baseline and also accepts the current 1.1.x release line. Explicit plugin feature requirements intersect both ranges, so the pairing plugin can require the next supporting release without admitting an older host.

The provider plugin owns discovery, network installation and settings UI. Core supplies optional capability-gated Host Services, persistent device identity, explicit destination confirmation and authenticated HTTP/WebSocket connections. The browser chooses paired connections from the native inventory. This is additive to Plugin API4 and IPC9; existing plugins retain their contracts. [Host connections](../../../architecture/host-connections.md) owns the protocol and lifecycle details.

The target grants instance-wide task and file access to an explicitly paired Host. Pairing is independent from transferred Session permissions and execution admission. Core retains secrets, signs each forwarded request and rejects replay. Remote invocations cannot change connection authority. The plugin exposes the gateway path rather than the ordinary listener, and adding pairing capability requires the normal plugin grant review.

Gateway shutdown follows the existing per-Scope plugin disposer. Removing one Scope retains an owner still enabled elsewhere; disposing the final Scope disables its gateway and closes watched connections. Global reload delegates to those bound disposers without reading or initializing an ambient Scope, so runtime-wide reload and approval cleanup work from Scope-free lifecycle contexts. The Host Service regression exercises two real Scope catalogs and a Scope-free reset; marketplace packaging verifies compatibility by admitted and rejected host versions rather than concatenating OR-range strings.

## Alternatives considered

**Only list Tailscale peers in the migration dialog.** Reachability does not prove that Synergy is installed or that the device is authorized. The plugin presents network candidates and probes the selected address before pairing.

**Keep a plugin-local paired-device list in front of the ordinary listener.** The receiver would still admit callers through the network route. Core must enforce the pairing grant where it admits requests.

**Share server tokens with the plugin or browser.** This distributes an unrestricted credential, complicates rotation and revocation, and conflicts with the public Host Service boundary. Device-bound signing keeps credential ownership in Core.

**Issue browser credentials and support source-independent remote UI in the first version.** That needs another identity, persistence and pairing lifecycle. The first version uses the local Host proxy and supports opening Synergy locally on the destination after the source goes offline.

## Consequences

Users can discover and pair devices without a fixed coordinator or a predetermined number of Hosts. The provider remains replaceable, and manual migration does not repeat completed computation or replicate workspaces continuously. Pairing adds security-sensitive authority records and clock requirements. The source must remain online for its proxy UI, while destination execution remains independent. Tests use isolated Hosts and a controlled Serve transport; real cross-network Tailscale acceptance needs physical devices.
