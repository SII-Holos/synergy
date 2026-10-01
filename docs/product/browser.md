# Browser Workspace

Browser is the Desktop workspace for using websites alongside tasks. Ordinary webpages belong to the project and can be used before a task exists. People and Agents in the same project share real pages; historical task pages and local file pages retain their task owner. The Web and CLI products use their own search, fetch and MCP capabilities; the native Browser panel requires a local Desktop server.

## Pages

Use the main plus button or choose Browser from its resource menu to create a real page without creating a task or calling a model. Each webpage is a peer tab beside files and other panels, with its website title or New tab. Website popups become peer tabs and retain normal login-window behavior. Closing a tab closes that page; switching tabs or hiding the side workspace keeps its native context alive. Startup and workbench restoration read metadata without opening new pages. Explicitly opening an empty Workspace restores the most recently viewed project page or creates a blank page. Hiding the Workspace preserves pages and selection.

The user's selected tab stays selected while the Agent works elsewhere. The follow-agent action is an explicit way to inspect the Agent's page. Human interaction does not pause an entire identity or task. Page dialogs, file selections and errors stay with their own page when switching tabs.

The address bar, history controls, viewport choices, annotations and diagnostic panels operate on the selected page. Agent tools use explicit page IDs returned by their page list. Each page owner supports 16 active pages and 64 saved pages, within a Desktop-wide limit of 64 active pages; capacity errors ask for an unused page to be closed.

The page menu provides find, webpage zoom, printing and PDF saving. Diagnostic panels and viewport presets live under Developer tools. Native webpage shortcuts use Command on macOS and Control on Windows/Linux. The person and Agent may operate the same page concurrently; no takeover or hand-back is required. If navigation invalidates an Agent observation, the Agent reads the page again instead of replaying an uncertain submission.

The tab context menu offers reload, copy address, external opening, close, close others and close tabs to the right. Batch closing stays within that task's selected workbench surface and respects each resource's close policy. Downloads and diagnostic views provide a direct return to the webpage. Suspended pages wait for recovery before querying native navigation controls.

## Saved website logins

Website logins are remembered automatically and reused by other tasks and Scopes in the same Desktop installation. Ordinary browsing needs no account setup in Synergy. Browser options → Browser settings contains login profiles and website permissions. Add a separate profile only when another account needs an independent login store. Opening a page copy with that profile creates a new peer tab; existing pages retain their original profile.

Temporary identities have no persistent login store and are discarded when their last page closes. They are excluded from task recovery. Website login remains a direct user interaction; the Agent can continue after the user completes login, including popup-based authentication.

Browser settings supports profile naming and default selection, with enablement, website-data clearing and deletion under Manage this profile. Disabling an identity suspends its pages across tasks and blocks Agent use. Clearing website data signs out its websites after closing live pages. Deleting an identity also removes its catalog entry. Neither operation changes another identity's data. Password import, manual save/update and origin-scoped fill are available separately from website session storage.

## Website permissions and files

Identity rules can narrow Agent access, upload and download permissions for an exact website origin. Task permissions remain authoritative: “Allow” does not elevate a restricted task. “Ask” is interactive in guarded mode and denied in autonomous mode; Full Access bypasses approval rules. Disabled identities stay unavailable in all modes. Human browser gestures remain explicit user actions.

Downloads appear as waiting until accepted. Chromium can already have buffered the response, but unaccepted files stay private and cannot be exported. The user can accept or cancel from Downloads, and Agent acceptance follows the identity's policy. Agent uploads and exports respect the initiating task’s Environment, Workspace generation and file permissions. A shared webpage does not adopt another task’s file authority. Executable download types and byte limits have independent safety checks.

## Recovery and evidence

Project and historical task pages restore as suspended after restart. Task completion, cancellation, archiving and Workspace changes preserve shared project pages; explicit page close destroys them. Resume restores the address and identity when available. A failed page offers a local retry without changing other tabs. Browser storage can preserve a website login; unsaved forms, JavaScript state, navigation history and one-use login transactions are not recovery guarantees.

Agent results distinguish dispatched actions, settling and observed page state. A timeout does not establish that a submission failed. After an uncertain action, inspect the page before deciding whether another action is needed. Screenshots and feedback are added to the captured task or new-task editable draft with their source URL and capture time. A marked point refers to the captured image, not a reusable live element handle. A changed task or reset draft cancels the addition; ordinary typing during capture is retained. Sending remains a separate composer action. Completed downloads remain available after their source page closes and can be saved, saved and opened, or added to the task draft.

Implementation ownership and limits are defined in [Browser runtime](../architecture/browser-runtime.md); durable visual rules live in [Web product contract](../../apps/web/PRODUCT.md).

## Local browser data

Desktop stores up to 100 unique recent addresses per persistent profile; the address bar suggests up to eight. Temporary profiles leave no recent history or saved passwords. Passwords use the operating system encryption service and are unavailable when it is locked or insecure. Only matching website origins may be filled, and filling never submits a form. Save/update is explicit from a populated login form.

Import opens a source picker with independent password and Cookie choices. On macOS, installed Chrome, Edge and Brave profiles offer direct transfer after OS authorization. Safari offers password import from its exported ZIP or CSV, with a visible export guide; Safari cookies are unavailable. All Desktop platforms accept password CSV, Safari ZIP containing one password CSV (including localized filenames), and Cookie JSON arrays or Playwright storageState.cookies. The new-tab search stays centered and the import entry lives in its footer. Existing records are preserved unless replacement is selected. Progress and final counts reflect completed records; cancellation retains completed imports. Unsupported partitioned cookies are reported rather than flattened. Clearing recent history, deleting passwords and clearing website data are separate operations; deleting a profile clears all three.

## Overlay presentation

Menus, recent suggestions and dialogs temporarily cover the native page. Desktop captures one bounded still image for that transition, hides the native view, and restores the same view after the last overlay closes. The image is noninteractive and discarded on resume or page change; it is never a browser control transport or an Agent screenshot stream. Screenshot previews use the shared wide dialog with a scrollable body, keeping actions reachable in small windows.
