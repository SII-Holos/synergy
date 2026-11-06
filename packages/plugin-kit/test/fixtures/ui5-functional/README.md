# UI API 5 functional example

This plugin uses only the public Plugin API, UI components and generated operation/event types. It opens distinct note resources, edits their titles and dirty state, negotiates closing, stages settings in an owned dialog, opens a nested Popover, registers a keyboard command and footer menu, and updates its counter through the existing plugin event connection. Its selection action presents the operation result in a host-owned popover.

Build with `synergy-plugin build`, pack with `synergy-plugin pack`, and start `synergy-plugin preview`. Approve the artifact in the isolated host. The footer opens settings and both note resources; editing a note then closing it exercises the discard guard. Save the note before closing to bypass that guard. The counter command is also available through the command palette and `Mod+Shift+U`.

Install the workbench example in the same preview to verify that these contributions survive a different Shell. The production-host acceptance test builds and packs both examples before loading them through the real approval, asset, registration and mounting paths. No application-private imports, DOM probing or secondary event transport are used.
