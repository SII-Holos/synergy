# Browser Workspace

Browser is the Desktop workspace for using websites alongside a task. Each task can keep multiple real pages open, and the user and Agent work in the same browser contexts. The Web and CLI products use their own search, fetch and MCP capabilities; the native Browser panel requires a local Desktop server.

## Pages

Opening the panel shows the task's existing pages without opening a website. The plus button opens a page; entering an address when the browser is empty opens the first one. Tabs show page titles, activity and pending prompts. Arrow keys, Home and End move between tabs. Closing a tab closes only that page. Website popups become separate tabs and retain normal login-window behavior.

The user's selected tab stays selected while the Agent works elsewhere. The follow-agent action is an explicit way to inspect the Agent's page. Human interaction does not pause an entire identity or task. Page dialogs, file selections and errors stay with their own page when switching tabs.

The address bar, history controls, viewport choices, annotations and diagnostic panels operate on the selected page. Agent tools use explicit page IDs returned by their page list. A task supports 16 active pages and 64 saved pages, within a Desktop-wide limit of 64 active pages; capacity errors ask for an unused page to be closed.

## Website identities

Personal is the initial persistent identity. Its logins can be reused by other tasks and Scopes in the same Desktop installation. Create a named identity to keep work, personal or another account separate. Choose “Open a copy as” to open the current address under a different identity. Existing pages retain their original identity.

Temporary identities have no persistent login store and are discarded when their last page closes. They are excluded from task recovery. Website login remains a direct user interaction; the Agent can continue after the user completes login, including popup-based authentication.

The identity manager supports naming, default selection, enablement, website-data clearing and deletion. Disabling an identity suspends its pages across tasks and blocks Agent use. Clearing website data signs out its websites after closing live pages. Deleting an identity also removes its catalog entry. Neither operation changes another identity's data. These controls do not import passwords from external browsers or provide a password manager.

## Website permissions and files

Identity rules can narrow Agent access, upload and download permissions for an exact website origin. Task permissions remain authoritative: “Allow” does not elevate a restricted task. “Ask” is interactive in guarded mode and denied in autonomous mode; Full Access bypasses approval rules. Disabled identities stay unavailable in all modes. Human browser gestures remain explicit user actions.

Downloads appear as waiting until accepted. Chromium can already have buffered the response, but unaccepted files stay private and cannot be exported. The user can accept or cancel from Downloads, and Agent acceptance follows the identity's policy. Uploads and exports respect the current Workspace and the existing file-permission system. Executable download types and byte limits have independent safety checks.

## Recovery and evidence

Returning to a task after restart shows its saved persistent pages as suspended. Resume restores the address and identity when available. A failed page offers a local retry without changing other tabs. Browser storage can preserve a website login; unsaved forms, JavaScript state, navigation history and one-use login transactions are not recovery guarantees.

Agent results distinguish dispatched actions, settling and observed page state. A timeout does not establish that a submission failed. After an uncertain action, inspect the page before deciding whether another action is needed. Screenshots, annotations, console/network evidence and downloads remain attached to their page and task.

Implementation ownership and limits are defined in [Browser runtime](../architecture/browser-runtime.md); durable visual rules live in [Web product contract](../../apps/web/PRODUCT.md).
