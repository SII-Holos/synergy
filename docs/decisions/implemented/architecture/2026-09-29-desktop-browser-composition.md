# Decision Record: Desktop selects the browser component

Status: implemented

## Problem

The full backend selection includes browser hosting even when launched by CLI or Web. Web development also starts an Electron browser host, adding an application dependency to an otherwise lightweight server workflow.

## Decision

The full and Web selections exclude browser-runtime. The Desktop selection includes it explicitly. Source Desktop startup chooses desktopComponents before Runtime registration; the installed launcher passes the Desktop host selection to its component loader. Ordinary CLI startup does not activate an installed browser component. The browser install shortcut selects Desktop rather than an independent Chromium host.

Desktop's managed server and local development orchestrator set the Desktop browser composition flag. Web development starts only the server and application. Browser component registration supplies HTTP services without contributing Chromium installation commands.

## Alternatives considered

- Hiding the Web panel alone retains the browser engine in CLI/server composition.
- Registering browser services when a panel opens changes a sealed Runtime's capabilities.
- Removing the shared frontend code also removes Desktop's renderer.

## Consequences

Browser hosting is a Desktop composition choice. This is the first independently tested part of the [page and identity implementation](../../proposed/architecture/2026-09-29-desktop-browser-pages-and-identities.md); engine, presentation and distribution cleanup remain tracked there until completed. Source catalog and development planner tests verify product selection independently of a running browser.
