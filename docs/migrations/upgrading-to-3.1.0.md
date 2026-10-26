# Upgrading from 3.0.22 to 3.1.0

This guide covers the released 3.0.22 installation and the 3.1.0 module-based runtime. The launcher and its complete matching runtime distribution must be upgraded together; replacing only the executable is not supported. Desktop uses its packaged updater or installer, not an independent CLI upgrade.

## Before upgrading

1. Finish or pause active work and stop the installation being upgraded. Close its Desktop application and confirm its managed server has exited. Do not stop unrelated instances.
2. Preserve the complete stopped data Home and the matching 3.0.22 distribution. Include configuration, credentials, plugin artifacts, database files and sidecars; copying only the main database file is not a complete backup. Keep this backup private.
3. Back up project files separately. They may live outside the data Home. Desktop browser identities and preferences belong to Electron user data and also require their own backup when needed.
4. Retain the original locations. Same-machine recovery depends on the saved project paths; a backup copied to another machine is not an automatic Workspace relocation.

## First start and verification

Install the complete 3.1.0 distribution and allow installation verification and saved-data migration to finish. Managed Desktop displays progress while work advances. An integrity or migration error is a failed start, not a reason to delete data or bypass validation.

Check an existing conversation, its attachments and completed tool history, then continue it. Invoke an installed plugin rather than relying only on its marketplace status. Restart once and create a fresh task. Backend Plugin API4 remains the stable family; executable frontend plugins must satisfy the separate [UI API compatibility requirements](../plugins/README.md#ui-model).

Keep the pre-upgrade backup until these checks pass. The [release acceptance procedure](../operations/desktop-release.md#released-upgrade-acceptance) documents the automated coverage and its limits.

## Recovery to 3.0.22

Stop only the upgraded installation. Preserve its entire post-upgrade Home separately for diagnosis and recovery of newer work. Restore the complete pre-upgrade Home at its original location and use the matching 3.0.22 distribution. Do not point 3.0.22 at a Home already migrated by 3.1.0, remove version guards, or merge individual database files from the two copies.

Verify old history, attachments and plugin execution before resuming work. Restoring the Home returns its saved state to the backup time; work created afterward is not automatically imported. External project-file changes are not rolled back by restoring the Home and must be reconciled separately.
