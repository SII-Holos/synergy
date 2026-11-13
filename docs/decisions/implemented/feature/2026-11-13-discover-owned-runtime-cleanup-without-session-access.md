# Decision Record: Discover owned Runtime cleanup without Session access

Status: implemented

## Problem

A cancelled native move can retain an unfinished destination preparation after its Session becomes unreadable. A conversation-owned recovery handle cannot discover those records from another page. An administrator's broader Runtime directory also cannot grant another member's cleanup authority. Separately, restoring a move must preserve the originally inspected directory name instead of substituting the computer's current default folder.

## Decision

The existing Account page owns a lazy My computers disclosure. Opening it reads one canonical Runtime page and retains only member registrations belonging to the current account and deployment. Each page preserves its service cursor even when filtering leaves no visible devices. Device registration state is presented independently of whether that computer is running. The page does not start a computer, allocate compute or read a Session.

An active owned registration can discover one page of its original cancelled-move descriptors through the generated cleanup API. The descriptor remains bounded metadata, identifies the original target and frozen manifest, and does not establish physical release. Opening a descriptor reuses the existing limited target-inspection widget. Only a matching result from the original target can establish completion; the optional recorded fact hash is insufficient. Changing pages, collapsing the disclosure or changing the account retires that owner's reads and dialog without altering another surface.

Revoked registrations show an explanation that cleanup belongs to the original Synergy installation. The human page does not issue machine recovery requests, enroll another key or imitate the original Runtime. The separately authenticated restricted recovery owner remains responsible for that workflow.

The existing connection-owned saved handoff record can retain a safe directory label with its original complete preparation plan. Saving requires a matching real preflight: Session, project, execution epoch, control revision, target and complete native mapping. Rendering after reload also matches the original handoff, epoch, mapping revision and selectors. These captions are UI metadata, contain no proof or credentials, and cannot authorize a request. Old records without a caption remain readable. Missing or mismatched names are shown explicitly, and directory acceptance remains unavailable until the original name has been established. An existing handoff cannot call the ordinary preflight to invent a replacement name.

Desktop's authenticated bridge admits the exact generated product routes used by conversation moves, cleanup discovery, Runtime availability and cloud-Workspace selection. Main retains sender validation, credential attachment, account revision checks, body limits and cancellation. Machine proof, object and restricted recovery routes remain outside the human bridge. The route-admission regression uses a real temporary authorization/account owner; this does not substitute for Electron presentation or native handoff-effect acceptance.

## Alternatives considered

**Discover records through Session history.** It requires authority that cancellation or revocation may have removed and cannot recover a lost local handle independently.

**Use an administrator's complete device list.** Directory visibility cannot establish ownership of another member's original target or machine key.

**Persist a second cleanup ledger in the frontend.** The service owns the canonical participant index. One current page and owner-bound pending metadata preserve recovery without creating another source of truth.

**Display the current default directory as the old target.** It can refer to another workspace, generation or selection revision and would misrepresent what the member accepts.

**Allow an unrestricted Desktop HTTP proxy.** It would expose machine and unrelated operations to the renderer. Exact product routes preserve the existing Main boundary.

## Consequences

Self-device discovery works independently of project execution and Session reading. Ordinary human inspection remains distinct from restricted recovery using the original machine key. Target-member and historical directory-name recovery require the separate handoff-bound native inspection API; the generic Runtime directory and current default folder are not substitutes.

The original lifecycle and comparison guarantees remain with [native adoption](../architecture/2026-11-13-adopt-existing-native-workspaces-through-original-handoff-claims.md) and [the bounded comparison interface](2026-11-13-review-native-directory-versions-before-handoff.md). This unit does not establish complete HAND capability or test an actual user Desktop.
