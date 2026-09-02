#!/usr/bin/env bun

import path from "node:path"
import { runBatchedTests } from "../../../script/shared/test-runner"

const root = path.resolve(import.meta.dir, "..")
// Playwright suites launch Chromium. bun test runs files in parallel worker
// processes and reaps dangling children when a worker exits, which can kill a
// sibling suite's freshly launched browser. Run every Chromium suite serially
// after the main batch to keep their processes alive.
const playwrightIsolated = [
  "test/components/app-shell/mobile-drawer-drag-region.test.tsx",
  "test/components/app-shell/mobile-drawer-root.test.tsx",
  "test/components/dialog/model-selector-layout.test.ts",
  "test/components/file-workbench/scrollbar-dark.test.ts",
  "test/components/file-workbench/selection.test.ts",
  "test/components/file-workbench/open-in-browser.dom.test.ts",
  "test/components/file-workbench/explorer-restore.dom.test.ts",
  "test/components/attachment-workbench/pdf-preview.dom.test.ts",
  "test/components/library/filter-menu-surface.test.ts",
  "test/components/menu-field/menu-field.test.ts",
  "test/components/prompt-input/prompt-input-hover-style.test.ts",
  "test/components/settings/components/ThemePicker.behavior.test.tsx",
  "test/components/settings/settings-dialog-dismiss.test.tsx",
  "test/components/settings/settings-mobile-layout.test.ts",
  "test/components/settings/panels/BossModePanel.test.ts",
  "test/components/session/question-prompt-style.test.ts",
  "test/components/session/raw-messages-layout.test.ts",
  "test/components/session/session-progress-island-motion.test.ts",
  "test/components/session/session-progress-todo-layout.test.ts",
  "test/components/session/session-transition-card-style.test.ts",
  "test/components/session/conversation-row-retention.test.ts",
  "test/components/session/dialog-fork-confirm.dom.test.tsx",
  "test/components/sidebar/session-draft-badge.dom.test.tsx",
  "test/components/sidebar/sidebar-attention-notice.dom.test.tsx",
  "test/pages/fatal-error.dom.test.tsx",
]

await runBatchedTests({
  root,
  timeoutMs: 30000,
  isolated: playwrightIsolated,
  isolatedTimeoutMs: 120000,
  browserOnly: [
    "test/components/note/document-editor-core.test.ts",
    "test/components/terminal/dispose-reentrancy.test.ts",
    "test/components/workspace/builtin-workbench-panels.test.ts",
    "test/context/font-preference-provider.test.ts",
    "test/pages/fatal-error.test.tsx",
    "test/plugin/builtin-navigation.test.ts",
    "test/plugin/global-themes-registrar-lifecycle.test.tsx",
    "test/plugin/theme-config-bridge.test.ts",
    "test/plugin/registries/slot-outlet.test.ts",
    "test/plugin/registries/tool-renderer-registry.test.ts",
  ],
  extraSerial: ["test/app-build-css-contract.test.ts"],
})
