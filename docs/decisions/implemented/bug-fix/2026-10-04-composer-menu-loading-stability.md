# Decision Record: Keep Composer geometry stable while menu metadata loads

Status: implemented

## Problem

Opening a computer menu starts health checks, and opening a project menu reads directory metadata. These optional reads suspend the entire Composer setup row. Its loading replacement has a different height, changing the welcome playfield's available space and resizing its Canvas twice. A directory failure also escapes the menu and prevents choosing otherwise available projects.

## Decision

Computer health and project directory resources have typed initial snapshots and render through `latest`. This follows the [Solid resource contract](https://docs.solidjs.com/reference/basic-reactivity/create-resource): an initial value avoids first-load suspension, and latest-value reads retain a resolved snapshot during refresh. The surrounding initialization boundary remains responsible for required resources.

Computer results belong to the current URL collection. Project results capture the client, connection and project collection that requested them. Consumers reject snapshots from a replaced owner. Computer checks still run whenever their menu opens; project metadata loads with its menu and refreshes when its owner changes.

Choices, triggers and the Composer remain mounted while metadata resolves. Directory failures settle independently: known paths remain readable, missing paths have a localized unavailable message, and project selection stays available. Loading and error labels occupy the existing secondary text row. Game pause, ambient motion, draft ownership and Canvas rendering retain their existing lifetimes.

## Alternatives considered

**A fixed-height replacement for the setup row.** It conceals one geometry change while still detaching controls and disrupting focus; it also couples a fallback to responsive Composer measurements.

**A menu-wide loading replacement.** It isolates suspension but hides choices already available locally and delays interaction for optional metadata.

**Changing Canvas resizing.** It treats a downstream symptom while the Composer layout and trigger lifecycle still change.

## Consequences

Menus can display a previous confirmed health result while checking again. Metadata snapshots remain component-local and are validated against their owner; no persistent cache or API contract is added. Browser regressions mount the real menus and production Session, Composer and welcome layout, hold requests pending, measure geometry and node retention, and exercise partial directory failure and a late response from a replaced connection. Existing setup, recovery and focus regressions remain in the same serial suite.
