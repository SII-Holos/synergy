import type { I18n } from "@lingui/core"
import type { SessionFileRestoreResult } from "@ericsanchezok/synergy-sdk/client"
import { S } from "./session-i18n"

export function fileRestoreFeedback(result: SessionFileRestoreResult | undefined, i18n: I18n) {
  if (!result) throw new Error(i18n._(S.rollbackRequestFailed))
  const restored = result.restoredFiles.length
  const failed = result.failedFiles.length
  return {
    type: failed ? ("error" as const) : ("success" as const),
    title: i18n._(failed ? S.rollbackFilesRestoreFailed : S.rollbackFilesRestored),
    description: failed
      ? [
          i18n._({ ...S.rollbackPartialRestore, values: { restored, failed } }),
          ...result.failedFiles.slice(0, 5).map((file) => `${file.file}: ${file.message}`),
        ].join("\n")
      : i18n._({ ...S.rollbackRestoreSuccessDesc, values: { count: restored } }),
  }
}
