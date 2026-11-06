# Decision Record: Use one mobile navigation surface and one Composer action hierarchy

Status: implemented

## Problem

The mobile Session toolbar opened both a navigation drawer and a tools drawer containing overlapping destinations. Welcome actions repeated the project and file entries already available from the Composer. Independently styled controls mixed small launcher labels, filled Agent chips, secondary buttons and different motion timings. Each surface worked in isolation, but the combined screen duplicated choices and gave ordinary configuration more emphasis than the task.

## Decision

The left drawer owns global mobile navigation. Its Recent and Projects tabs retain pagination, session state, pinned/date grouping, shared search and account identity. Global destinations use two-column horizontal icon-and-label rows rather than small icon-above-label launchers. Notes and registered Desktop-native Browser panels share the same drawer in their own group; capability filtering and the existing Session requirement for Browser remain authoritative. The duplicate tools drawer, top-bar launcher and obsolete test registration are removed.

New is a quiet row rather than a filled primary action. It starts in the current project on Session routes, the selected project in a drilldown, or Home on global pages. The Session top-bar action uses the same new-task navigation helper, including welcome scene rotation. The header stays 48px high and reserves 44px targets around a model label that truncates before controls overlap.

Drawer actions share the 14px text role, 20px glyphs and neutral state feedback. Entry uses the shared structural duration, exit the base duration, and ordinary feedback the fast duration. The existing modal owner retains the surface until its exit animation settles, returns focus, cancels obsolete close completion after reopening, and closes at the desktop breakpoint. Reduced motion removes spatial animation. Nested Settings retains its parent drawer and returns focus to its opener.

Collections and shortcuts share one vertical scroll owner so long lists and short screens retain every destination. Identity and Settings stay outside that scroll owner above the bottom safe area. Confirmed Holos capability makes the remote-derived identity an Account entry; without it, the same row is a noninteractive summary without a chevron. The gear remains the general Settings entry.

Mobile Settings keeps its existing panel and save controller. A shared footer remains reachable after returning to categories with a draft or save result, rather than disappearing with the detail body. Its search input and clear action fit inside one 44px surface; clearing restores input focus, and text-input appearance follows the existing caret-only rule. Desktop keeps its modal, navigation measure and detail-footer alignment.

The mobile Composer retains the [single toolbar and scrolling configuration line](../feature/2026-10-23-narrow-session-composer-single-row-and-chip-row.md). Configuration controls share 14px medium text, 18px glyphs and 44px targets without persistent decorative fills. Open, pressed and keyboard-focus feedback uses canonical surfaces; Full Access retains its dedicated contrast treatment. Hover applies only to fine pointers that support it. The card uses a quiet border without a shadow and 20px toolbar glyphs. Mobile greetings do not repeat project or file actions, with or without games. Desktop geometry and the welcome playfield's resting dimensions remain unchanged by Composer expansion.

Prediction keeps one capability-gated service instance attached to the Composer. Its desktop button and mobile Add action use the same bound API; only presentation changes at the breakpoint. Mobile progress and prediction failures remain below the toolbar, while desktop progress uses the button's busy state. Resizing does not re-register the extension, dispose its request or recreate the editor.

This supersedes the [earlier mobile navigation-root decision](../../archived/feature/2026-10-23-mobile-drawer-as-navigation-root.md), retaining its shared search, grouping and remote-derived account identity while replacing its primary Home-target New action and separate launcher presentation. It does not add navigation state, alter draft ownership or change submission semantics.

## Alternatives considered

**Keep both drawers and make them look alike.** This leaves duplicate global destinations and two navigation choices on the smallest toolbar. One surface removes the choice without removing destinations.

**Hide Agent and permission inside Add.** These are send-time configuration, unlike optional assistance. Retaining the scrolling configuration line keeps them reachable and inspectable before submission.

**Keep mobile welcome project and attachment shortcuts.** They repeat the Composer's existing project selector and Add menu and consume space otherwise available to the welcome scene. The remaining real controls retain those capabilities.

**Restyle shared controls globally.** Mobile density does not justify changing desktop control geometry or unrelated settings. Surface-owned styles preserve shared interaction behavior and canonical tokens without introducing a parallel palette or overlay stack.

**Mount a prediction owner independently in each responsive branch.** Complementary conditions do not guarantee that one branch cleans up before the other registers. A stable owner with separate controls avoids both duplicate registration and request cancellation during resizing.

**Introduce a mobile-only Settings route in this refinement.** The panel itself is reusable, but navigation needs browser-history leave protection, refresh behavior, durable internal section navigation and a correct plugin Shell page identity. The existing plugin route classifier otherwise treats an unknown route as a Session. This broader change is deferred under the requirement to keep this iteration small; Settings remains a modal, not a full-screen surface mislabeled as an independent page.

## Consequences

Mobile navigation has one entry, configuration has one typographic role, and welcome content adds no competing task actions. Tool destinations remain one drawer-open away; a long configuration line scrolls instead of wrapping. New from a project Session deliberately differs from the desktop sidebar's global New target by retaining that project's ownership.

Behavioral coverage mounts the real drawer, Settings panel, top bar, Composer controller and production styles. It checks capability filtering, account versus general Settings entry, project-owned New, nested dialogs, focus return, rapid reversal, narrow overflow, short-screen scrolling with a bottom safe area, reduced motion, file selection, category-return saving and discard protection, desktop geometry and stable welcome playfields. The drawer fixture uses the shared compiled browser fixture instead of per-run development-server optimization. Cold compilation has its own preparation window; interaction deadlines stay unchanged. Whole-page inspection complements those focused suites because isolated component presence cannot establish coherent page layout.
