# Browser Runtime

Browser is a Desktop-local capability. The full Desktop composition selects `browser-runtime` and connects to Electron's native broker; CLI and Web compositions omit it. The shared Web renderer contributes Browser UI only when both the server capability and the native Desktop bridge are available. A remote server, Docker Environment, or absent execution selection cannot acquire the local controller. Web search, fetch and external MCP tools remain independent capabilities.

## Ownership

| Owner                      | Responsibility                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/browser-core`    | Strict Protocol v4, CDP controller, page locators, navigation leases, redaction and file staging primitives                                |
| `packages/browser-runtime` | Task page catalog, persistent identities, authorization, Workspace leases, routes/tools/events, migrations and artifacts                   |
| `apps/desktop`             | Electron lifecycle, one real `WebContentsView` per live page, native popup adoption, profile partitions, diagnostics and native attachment |
| `apps/web`                 | Peer workbench page tabs, address bar, browser settings, page diagnostics and recovery UI through the generated SDK                        |
| Harness                    | Control profiles, approval policy, Scope/Session/Workspace authority and file-import admission                                             |

A Browser owner is a Session inside a Scope; explicitly scope-owned integrations use the same page model. The server's `ownerKey` is canonical. Route directories do not derive owner keys or profile partitions. Each page has an immutable ID and `profileId`, optional `openerId`, URL/title, activity and lifecycle state. Human selected page, agent target page and profile identity are separate values.

The limits are 16 active pages per owner, 64 saved descriptors per owner and 64 active pages per Desktop. Reservations count in-flight creations so concurrent opens cannot bypass capacity. Profile and per-profile origin-rule catalogs are bounded to 256 user-created entries; migrated identities retain their historical partitions even beyond that creation limit.

## Pages and commands

State reads, subscriptions, panel mounting and profile listing allocate no page. `open` creates a page; user navigation with no selected page opens one. Every subsequent control explicitly targets `pageId`. Unknown, closed and suspended IDs produce actionable errors; an observation or ordinary navigation never silently recreates a page. `resume` is the explicit recovery operation.

Open requests carry a `requestId`; commands carry a `commandId`. Repeated IDs within the live owner reuse their result and reject changed arguments. Replay is bounded and is not a durable cross-restart transaction log. Commands serialize within one page, while unrelated pages progress independently. Dialog replies bypass a blocked page queue so a command waiting for a dialog can complete. Unknown action outcomes require fresh observation, never automatic replay.

The Session's Workspace lease is acquired before the page command queue and retained through file reads, authorization and dispatch. Workspace or Environment transitions close old pages before committing authority changes and clear replay results. Failed closure preserves the old binding for an explicit retry. Local files are revalidated against the bound Workspace after symlink resolution; hidden paths and `.git`, `.synergy`, and `node_modules` are excluded. Exports use Harness file-import admission and private staging, with cancellation and qualified file events.

Agent navigation defaults to `load` settling with a 15-second budget. Actions default to `networkquiet` with a 10-second budget; explicit settle budgets cannot exceed 30 seconds. Settle timeout is observation data, not proof that an action failed. Results include current page state and best-effort snapshot evidence. Snapshot references are document-generation scoped; ambiguous targets return bounded candidates rather than selecting arbitrarily.

## Native pages and popups

Each page owns a real Electron browsing context. `window.open` and target-blank requests adopt Electron's supplied child `WebContents` through `createWindow`, preserving opener, named-window behavior, request method/body and normal browser messaging. Reconstructing a popup by loading its URL loses those semantics. Popups inherit the opener's identity and become canonical owner pages; closing an opener does not close its child. `window.close` removes that page. A renderer crash recovers its generation without treating ordinary destruction as a crash.

Human input and Agent operations may run concurrently. Agent commands do not activate, select or focus tabs. Only explicit user tab selection or the follow-agent action changes the visible page. Page prompts, file choosers, errors, downloads and agent activity are keyed by page. Native view attachment follows the selected page and measured renderer bounds. Overlapping UI blockers hide the native view until the final blocker closes; they do not destroy it. On the visible-to-hidden transition Desktop may deliver one bounded JPEG still image (maximum 1.4 MB) to retain visual context. This noninteractive cover is page- and URL-scoped, discarded on resume, and never used as a browser transport. Every page maps to a Browser resource tab in the shared workbench strip; there is no nested Browser tab strip. A catalog subscription survives active-panel changes to reconcile titles, popups and closures without selecting a tab. Explicit Add → Browser creates a page; closing its resource tab closes it, while switching tabs only detaches presentation. API open responses may precede catalog events, so reconciliation preserves newly opened local resources until the catalog observes them. Login-profile management and Agent website rules use a shared settings modal reached from Browser options; ordinary browsing exposes no identity-management row.

Native attachment and UI controls require fresh owner/server-bound Desktop tickets. The broker accepts loopback servers only. There is no WebRTC, iframe, screenshot-stream or headless presentation fallback. Screenshots remain deliberate artifacts.

## Identities and authorization

The versioned global identity catalog stores names, stable partitions, enablement, revision, default selection and per-origin policies. The default Personal identity persists across tasks and Scopes. Named persistent identities isolate accounts; temporary identities use non-persistent partitions and disappear after their last live page closes. Pages never change identity in place: opening a copy makes that choice explicit. Login is normal user interaction with the native page, including native popup flows; the Agent resumes with new observations after the user completes login.

Electron owns cookies and website storage inside the identity partition. Credentials are not copied into model prompts, API profile records or task checkpoints. Profile partition names include the catalog's installation ID; legacy identities preserve their exact historical partition. A shared identity's proxy, permission handlers, login handler and download dispatch are reference-counted across pages and tasks. Closing one task cannot revoke another task's live network access or erase its login.

Each identity can narrow Agent access, upload and download operations by exact normalized HTTP(S) origin. `inherit` and `allow` retain the task's capability policy. `ask` requests approval in `guarded` and denies in `autonomous`; `deny` denies both. `full_access` allows permission-system capabilities, while a disabled/missing identity remains an ordinary unavailable resource in every profile. Human browser gestures retain user authority. These policies govern Agent operations, not every subresource request made by a website.

Policy revisions invalidate cached observations and authorizations. Commands recheck the revision and relevant page URL after approval; navigation occurring during a prompt cannot silently retarget an approved action. Disabling an identity blocks new operations and suspends all its live pages across owners. Clearing website data closes those pages, clears native storage/cache/authentication and connections, then restores prior enablement and default selection only on success. Deletion clears data before removing the catalog entry. Suspended pages for a deleted identity remain visibly unavailable until closed. Already-dispatched website effects cannot be undone by revocation.

Downloads first enter `awaiting_approval` in private managed storage. Chromium may finish a buffered response despite `pause()`; that file remains unavailable to export until explicitly accepted. Agent acceptance passes the identity's download rule and Harness capability gate; a user can accept or cancel in the download panel. Cancellation/disposal removes unaccepted staged files. Dangerous file types and byte limits remain enforced independently of approval. Uploads pin Workspace authority, bound actual bytes while reading and revalidate file identity before dispatch.

Chromium owns webpage-origin security, CORS, TLS and Local Network Access. The authenticated local gateway forwards traffic and releases profile grants at last use; it does not impose a second IP-range or DNS policy. Native content grants Chromium network permissions while unrelated device, media, location and filesystem requests remain denied.

## Persistence and recovery

Session storage v5 contains page descriptors, annotations and downloads. Persistent Electron partitions carry login state. Session restore is lazy and marks saved pages suspended. Temporary pages are excluded from persistence. Closing a page removes its descriptor; normal shutdown suspends persistent descriptors. Recovery reloads the saved URL/profile and preserves the stable page ID, but does not promise JavaScript heap, forms, navigation history or an OAuth transaction survived process loss. Workspace-local URLs are redacted and cannot be silently replayed against new file authority.

The central migration runner invokes the Browser-owned v5 migration. A v4 owner maps to an imported identity with exactly the old SHA-256-derived partition. Owners are never merged automatically. Existing v5 data wins on rerun; historical headless files remain untouched without keeping their execution implementation. Persisted state is validated before upgrade publication. Fresh installation allocates no browser pages.

Native recovery replaces a page generation, retaining owner/page/profile identity, URL, bounds and visibility. Safe observations remain available where the renderer can answer; side effects fail promptly during restarting/failed states. Healthy `resume` is idempotent, concurrent resumes share one recovery attempt, and failed recovery has a bounded explicit retry path. Failures are page-scoped and do not switch tabs or fail unrelated pages. Broker reconnection requires fresh native authority and never automatically repeats a side effect.

## Verification references

The implementation workflow and required tests live in [change-browser-runtime](../../.synergy/skill/change-browser-runtime/SKILL.md). User flows live in [Browser workspace](../product/browser.md). Packaging follows [Desktop release](../operations/desktop-release.md). The architectural rationale is recorded in [Desktop browser pages and identities](../decisions/implemented/architecture/2026-09-29-desktop-browser-pages-and-identities.md).

## Browser product data and results

Desktop’s `browser-data-store` owns version 1 per-partition local data: OS-encrypted password values, origin/username metadata, and at most 100 unique recent URLs. Temporary profiles persist neither. Native `dataAction` validates requests, bounds file imports, returns progress/summary metadata and restricts fills to the exact website origin without submitting. Decrypted credentials never enter renderer results or Agent tools. Website-data clearing preserves this store; explicit profile deletion sends `removeSavedData` through the host message. CSV and Safari ZIP password imports and Cookie JSON are the supported interchange formats.

Native `pageAction` targets a stable page for find, zoom, print, PDF and bounded viewport/full-page capture. A capture crossing navigation fails. `fileAction` accepts bounded bytes from the trusted application renderer, asks for a native destination, and never accepts a renderer-provided filesystem path.

`browser.downloadArtifact` validates the task owner and completed state before pinning a regular, nonsymlink download file in owner storage, copying bounded bytes into the existing Asset store and returning an attachment reference. It does not depend on the source page remaining open. UI draft additions capture the destination draft before asynchronous work and reject a changed conversation; they do not create annotations in Session context or send a message. Screenshot feedback carries a historical image, source URL/time and optional image coordinates, never a live locator after navigation.
