# Decision Record: Browser source import

Status: implemented

## Problem

A file-format selector makes browser migration feel like a developer utility. It omits installed browser profiles, separates passwords from cookies into unrelated operations, and gives insufficient guidance when the operating system prevents direct access.

## Decision

Use one compact import dialog from the new-tab footer, page menu and Browser settings. Select a source and independent password/Cookie switches, preserve existing entries by default, place replacement under import options, and show results per type. A browser source must state its actual supported transfer method. The new tab has a centered search field and a quiet footer import action.

Desktop discovers macOS Chrome, Edge and Brave profile metadata without requesting credentials. Only an explicit import reads their selected local databases and requests their Safe Storage entry through the operating system. Native imports use bounded read-only SQLite transactions, the Chromium macOS v10 format and cookie schema 24 domain binding. Local and account password databases are included. Unknown encryption and partitioned cookies are rejected rather than reinterpreted. Credentials stay inside Desktop, imported passwords use the existing OS-encrypted store, and results contain counts and fixed error categories.

Safari uses its supported export flow: ZIP/CSV passwords, with localized ZIP member names recognized by column structure. Generic password CSV/Safari ZIP and Cookie JSON remain available on all Desktop platforms. Windows/Linux direct profile import, Safari cookie extraction, passkeys and verification codes are outside this implementation. No security protection is disabled to provide another source.

This extends the file-transfer decision in [Native browser product controls](../architecture/2026-09-29-browser-product-controls.md). Its local data ownership and origin-scoped filling rules continue to apply.

## Alternatives considered

**Only restyle the file selector.** This would leave the main migration friction intact on supported local browsers.

**Present all browser sources as direct imports.** This would promise access the platform does not provide. Safari's export interface and protected Windows browser encryption require distinct support statements.

**Read all browser data when opening the dialog.** Source discovery needs only names and available data types. Deferring credentials to the explicit import action avoids unnecessary OS prompts and data access.

## Consequences

Direct macOS import depends on Chromium database and encryption versions; unsupported records produce partial results or an actionable file-export path. Cookie transfer cannot guarantee a website will accept a session. The native reader does not copy source databases, launch external browsers, change Keychain permissions or obtain elevated privileges.

Behavioral fixtures verify metadata-only discovery, profile path validation, account databases, encryption failure, cancellation, per-type results, duplicates and cookie scope. A real Electron fixture covers the Node SQLite reader, destination password encryption and Chromium cookie writes using disposable source data; it does not import personal credentials. UI acceptance covers the source picker, independent switches, Safari guidance, narrow layouts, theme polarity and focus return.
