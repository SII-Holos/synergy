# Decision Record: Let Desktop main select and own member Runtime processes

Status: implemented

## Problem

A member-aware server manager does not select a stable device identity or connect account authorization to Home provisioning. Giving the renderer process launch paths or local bearer credentials would widen its authority, while starting every saved organization on application launch would create unnecessary resident processes.

## Decision

Desktop main owns a registry keyed by its verified organization connections. The registry persists one versioned device UUID through a locked private atomic write, and derives each member Home from organization, account and device. Existing Homes without their device record require explicit recovery. Public enrollment metadata has a Node-consumable entry separate from Bun networking; a restart validates its identity and deployment before selecting it.

Typed preload operations query member state or request an explicit start for an existing connection. They use the existing trusted-frame, document-generation and cancellation checks. The renderer cannot provide a Home, process arguments, machine identity, ticket or listener credential. State returns the organization connection, machine Runtime identity and lifecycle state only. Main requests initial registration through the generated organization SDK and passes the ticket privately to the existing server manager. A matching enrollment avoids another registration request on restart.

Concurrent start callers share one owned attempt. The final caller's cancellation stops unfinished preparation or launch and drains cleanup; an individual cancellation cannot stop another caller's attempt. Once started, a Runtime outlives renderer navigation and account sign-out. Signing out disables further authenticated client starts without transferring or deleting that account's Home. Update preparation stops owned member processes, and application quit closes the registry and drains them.

## Alternatives considered

**Let the renderer select a Home or receive the local bearer.** The renderer needs product operations and status, not authority to choose another account's storage or bypass organization command admission.

**Create all member processes when listing connections or switching spaces.** Discovery should not allocate execution resources. Explicit startup preserves lightweight space selection and keeps background work independent from the current view.

**Give each request its own supervisor.** Multiple callers for one account would contend for the same Home. Shared attempts with caller-specific cancellation preserve one process owner and independent request lifetimes.

## Consequences

Device and account identity survive application restarts without using the personal Runtime or sharing its environment. Damaged device identity cannot silently create a second machine registration. Local member credentials remain available only to main-owned consumers. Real child-process tests cover independent organizations, duplicate starts, cancellation and recovery rejection; metadata tests also execute in Node. Native preload checks cover trusted and foreign frames. Native Browser ownership and member work presentation retain their separate implementation responsibilities.
