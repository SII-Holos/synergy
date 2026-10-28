# Decision Record: Retire centralized identity and channel credentials

Status: implemented

## Problem

Personal work does not require a centralized identity. Retiring the identity integration must preserve readable history and unrelated provider credentials, including upgrades from older credential formats and configuration imports.

## Decision

Harness registers separate startup migrations for retired identity credentials and file configuration. Credential cleanup precedes the legacy provider-store conversion, operates on raw records under the provider-store lock, and preserves unrelated fields and pool entries. When a retired primary credential has unrelated pool entries, the migration promotes a retained entry without discarding the pool. Changed secret files are atomically published with private permissions. Invalid credential stores fail the migration without being replaced with an empty store.

Configuration retirement removes the former identity domain, its legacy fields and the dependent channel accounts. The central import transform also handles configuration discovered after startup. Saved feature choices are retired explicitly while unknown and unrelated choices remain intact. Exclusive configuration hosts still migrate credentials and leave file configuration pending.

Historical migration receipts and Session records remain intact. Contact and mailbox records stay stored without active readers. Repository identities, product domains and Desktop application identifiers retain their existing values.

Installation selection v3 removes the retired component roots from already upgraded homes while retaining previous selection files as evidence. Launcher upgrades use the existing generation transaction to remove explicit retired roots, retain third-party pins and plugin grants, and leave pinned old worker generations untouched.

The shared Personal space control replaces account identity in desktop and mobile navigation. It exposes only Settings, Providers and Repository. Its desktop footer remains outside the collapsed panel so keyboard access survives sidebar collapse; menu actions restore focus before opening a nested settings dialog. No organization state or placeholder actions are introduced. The control retains the established footer sizing, hover feedback, menu alignment and expanded/collapsed placement; identity retirement does not require a new menu style. Sidebar headers contain only navigation controls across Web and Desktop, keeping product identity in the footer.

The retired runtime packages, schemas, routes, CLI, tools, UI and packaged companion assets are removed together. The account settings card, action state helpers and status copy whose sole production consumer was the retired channel are removed with their tests. Feishu account model and variant selection and generic managed-project navigation retain their focused coverage. Legacy Agenda owner detection remains to keep retired deadline jobs inert; history imports and migration receipts remain readable.

## Alternatives considered

**Rely on schema parsing to drop unsupported credentials.** This can discard a mixed credential pool and leaves retired secrets on disk. A versioned raw-data migration makes the deletion precise and repeatable.

**Delete all identity-related data.** Contact, mailbox and Session history have independent archival value. Only retired authentication material and configuration are removed.

**Combine credentials with file configuration.** An exclusive configuration source replaces configuration files but still uses the local credential store. Separate migrations preserve that distinction.

## Consequences

Fresh installations and upgraded Homes use the same current path. The retirement retains a small historical transform and migration receipts, but does not require a live identity component. Invalid secret files require recovery rather than silently losing unrelated credentials.
