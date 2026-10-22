# Decision Record: Make the mobile drawer the navigation root instead of a launcher

Status: implemented

## Problem

The narrow-viewport navigation drawer exposed two tabs, a Recent list, a Tools grid and a Settings row. It had no search entry, no "New session" at its root — that action existed only inside a project drilldown — no session grouping and no identity. The three things a phone user does most often therefore required leaving the drawer for another surface, and the account identity that the desktop sidebar renders was absent from the only navigation surface a phone can reach.

Search itself already existed: `GlobalSearchModal` is mounted by the layout shell and the desktop sidebar opens it through `onSearchOpen`. The gap was wiring, not capability.

## Decision

The drawer header gains a search button that closes the drawer and opens the existing global search modal through `onSearchOpen`; the layout passes its existing callback down instead of the drawer owning a second search surface. A primary "New session" action sits above the tabs and routes to the Home scope, matching the desktop sidebar's new-task target. Session rows group under Pinned, Today and Earlier, with the flat list retained when no group labels are supplied so the component stays usable without the grouping contract. Pinned entries need their own heading rather than a place in the recency run: `orderNavEntries` sorts pinned sessions ahead of everything, so grouping by adjacent equal headings would emit Earlier/Today/Earlier for a pinned old session above a fresh one. The footer holds the account row beside a settings icon button; both open settings.

Identity derivation moves into `resolveAccountIdentity`, a pure function shared by the desktop sidebar and the drawer, so the two surfaces cannot disagree about the displayed name, description, connection tone or avatar. It takes the labels a surface already owns, because both surfaces translate from the same descriptor set but call them differently.

Every control inside the drawer now meets the 44-pixel touch floor. Measuring the upgraded drawer showed the header icons at 32 pixels and the Recent/Projects triggers at 28 pixels; a narrow-media-query rule inside `mobile-drawer.css` raises all drawer buttons, which is safe because the drawer never renders at desktop width.

Measured at 375×812: search, close, new session, the tabs, tools and the account row all render and respond, the account row reads "HOLOS account / Not signed in", no control falls below 44 pixels, and `scrollWidth` equals `innerWidth`. The drag-region and recent-list suites continue to pass unchanged apart from the added Holos stub.

## Alternatives considered

**Build a dedicated drawer search field with inline results.** It duplicates paging, keyboard handling and result rendering that the global modal already owns, and would produce two search experiences with different ranking.

**Keep search out and rely on the session list.** The Recent list loads a bounded page; searching across older sessions is not reachable by scrolling, so the absence was a real gap rather than a density choice.

**Group by date only and let pinned entries fall into their recency bucket.** Rejected after measurement: `orderNavEntries` sorts pinned sessions first, so a pinned session from last week lands above today's sessions and a date-only grouping by adjacent runs emits Earlier/Today/Earlier. Bucketing into fixed Pinned/Today/Earlier lists keeps the order stable; the heading is omitted when its bucket is empty.

**Render a full account menu in the drawer.** The drawer is a navigation root, and the desktop sidebar already owns the account menu surface; the drawer row opens the same settings destination, which keeps one menu implementation.

## Consequences

The drawer is now a complete navigation root for narrow viewports: search, new session, recent sessions with grouping, projects, tools and identity all live in one surface. The 44-pixel rule applies to the drawer as a whole rather than per control, so a future control added inside it inherits the floor without remembering it.

The drawer depends on the Holos context, which every authenticated shell mounts; the drag-region fixture needed a stub for it. Group headings shift row positions compared with the flat list, so the existing recent-list assertions continue to target session rows by `data-session-id` rather than by index.
