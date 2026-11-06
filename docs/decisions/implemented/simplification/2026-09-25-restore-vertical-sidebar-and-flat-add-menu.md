# Decision Record: Restore vertical sidebar sections and a flat Add menu

Status: implemented

## Problem

Category tabs replace the familiar sidebar hierarchy with exclusive views and prevent users from keeping several session categories open together. Group headings in the small Composer Add menu add vertical space without helping distinguish its short action list.

## Decision

The desktop sidebar uses five vertically stacked disclosures: Recent, Home, Channel, Background and Projects. Recent and Projects start open; the other categories start closed. Keep the registered tools above the original tag-and-collection scroller and the account below it. Recent keeps its unread acknowledgement on the heading row; Projects keeps its management controls. Native disclosure buttons retain keyboard activation and announced state, and hidden content remains inert. Each category retains its canonical data projection, nested ownership and pagination. Session typing-autofocus leaves focused native controls and interactive button, tab or menu roles in control of their keys, so Space activates a disclosure instead of inserting a space in the Composer.

The shared Add list flattens existing context, agent and workflow items in their current order. It omits visible group headings and inter-group spacing while preserving action guards, selection, keyboard navigation, Escape and trigger focus return.

This supersedes the desktop presentation in [sidebar collection categories](../bug-fix/2026-09-25-preserve-sidebar-collection-categories.md) and the desktop tabs and Add grouping in [navigation, working location and browser recovery](../bug-fix/2026-09-25-clarify-navigation-location-and-browser-recovery.md). Mobile drawer, identity, working-location and recovery decisions remain unchanged.

## Alternatives considered

**Keep five peer tabs.** Tabs fit one collection into the available height, but hide sibling content and replace the user-selected vertical hierarchy.

**Keep group headings in the Add menu.** The short list is already differentiated by its labels and icons; headings and gaps make the menu taller without adding an action.

**Restore the entire older component.** That would also discard keyboard and hidden-focus fixes. The restoration changes layout while retaining those behaviors and existing domain owners.

## Consequences

Several categories can stay open together, so long recent lists can push later categories below the fold. They share the original collection scroller, and collapsing Recent makes the later sections reachable without scrolling through its sessions. Browser tests cover independent and nested disclosures, hidden focus exclusion, tag search, pagination, acknowledgement, fixed tools, Chinese and English layouts at 230/300/420 px, and flat menu action guards and dismissal.
