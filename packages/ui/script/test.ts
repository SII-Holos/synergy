#!/usr/bin/env bun

import path from "node:path"
import { runBatchedTests } from "../../../script/shared/test-runner"

const root = path.resolve(import.meta.dir, "..")

await runBatchedTests({
  root,
  timeoutMs: 120000,
  isolated: [
    "test/components/message-part-error-boundary.test.ts",
    "test/components/activity-trace.dom.test.ts",
    "test/components/diff-patch.dom.test.ts",
    "test/components/code.dom.test.ts",
    "test/components/compact-reasoning.dom.test.ts",
    "test/components/compact-reasoning-settlement.dom.test.ts",
    "test/components/session-turn-activity.test.ts",
    "test/components/session-turn-activity-switch.dom.test.ts",
    "test/components/session-turn-timeline.test.ts",
    "test/components/session-turn-timeline-boundary.test.ts",
    "test/components/session-turn-projection.test.ts",
    "test/components/tool/renders/task.test.tsx",
    "test/components/tool/renders/standard.test.tsx",
    "test/components/tool/renders/file-ops.test.tsx",
    "test/components/tooltip.test.ts",
    "test/components/provider-icon.test.ts",
  ],
  browserOnly: ["test/hooks/use-filtered-list.test.tsx"],
})
