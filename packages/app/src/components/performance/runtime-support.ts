import type { MessageDescriptor } from "@lingui/core"
import type { I18n } from "@lingui/core"
import type { PerformanceSummary } from "./types"
import { P } from "./performance-i18n"
import { formatBytes } from "./chart-model"

export type RuntimeSupportItem = {
  label: MessageDescriptor
  value: string
  tone: "default" | "warning" | "success"
}

export function runtimeSupportItems(summary: PerformanceSummary | null | undefined, i18n: I18n): RuntimeSupportItem[] {
  const runtime = summary?.runtime
  if (!runtime) {
    return [
      { label: P.runtimeLock, value: i18n._(P.runtimeLockStateUnknown.id), tone: "warning" },
      { label: P.runtimeMirrorFiles, value: i18n._(P.runtimeMirrorFilesValue.id, { count: "0" }), tone: "default" },
      { label: P.runtimeRecentErrors, value: "0", tone: "default" },
      { label: P.runtimePendingSessions, value: "0", tone: "default" },
      {
        label: P.runtimeSessionRuntimes,
        value: i18n._(P.runtimeSessionRuntimesValue.id, { total: "0", running: "0" }),
        tone: "default",
      },
      {
        label: P.runtimeCortexTasks,
        value: i18n._(P.runtimeCortexTasksValue.id, { total: "0", running: "0" }),
        tone: "default",
      },
      { label: P.runtimeMessageCache, value: i18n._(P.runtimeUnknown.id), tone: "default" },
      { label: P.runtimeLlmStreams, value: i18n._(P.runtimeUnknown.id), tone: "default" },
    ]
  }
  const lockState =
    runtime.alive === undefined
      ? i18n._(P.runtimeLockStateUnknown.id)
      : runtime.alive
        ? i18n._(P.runtimeLockStateAlive.id)
        : i18n._(P.runtimeLockStateNotRunning.id)
  const healthState =
    runtime.healthy === undefined
      ? i18n._(P.runtimeHealthStateUnknown.id)
      : runtime.healthy
        ? i18n._(P.runtimeHealthy.id)
        : i18n._(P.runtimeNeedsAttention.id)
  const processDetail = [lockState, runtime.pid ? `pid ${runtime.pid}` : undefined, runtime.mode]
    .filter(Boolean)
    .join(" · ")
  return [
    {
      label: P.runtimeLock,
      value: `${processDetail || lockState} · ${healthState}`,
      tone: runtime.healthy === false || runtime.alive === false ? "warning" : runtime.healthy ? "success" : "default",
    },
    {
      label: P.runtimeMirrorFiles,
      value: i18n._(P.runtimeMirrorFilesValue.id, { count: String(runtime.mirrorFiles) }),
      tone: "default",
    },
    {
      label: P.runtimeRecentErrors,
      value: String(runtime.recentErrors),
      tone: runtime.recentErrors > 0 ? "warning" : "default",
    },
    {
      label: P.runtimePendingSessions,
      value: String(runtime.pendingSessions),
      tone: runtime.pendingSessions > 0 ? "warning" : "default",
    },
    {
      label: P.runtimeSessionRuntimes,
      value: i18n._(P.runtimeSessionRuntimesValue.id, {
        total: String(runtime.sessionRuntimes.totalCount),
        running: String(runtime.sessionRuntimes.runningCount),
      }),
      tone: "default",
    },
    {
      label: P.runtimeCortexTasks,
      value: i18n._(P.runtimeCortexTasksValue.id, {
        total: String(runtime.cortexTasks.totalCount),
        running: String(runtime.cortexTasks.runningCount),
      }),
      tone: "default",
    },
    {
      label: P.runtimeMessageCache,
      value: runtime.messageCache
        ? i18n._(P.runtimeMessageCacheValue.id, {
            bytes: formatBytes(runtime.messageCache.totalBytes),
            entries: String(runtime.messageCache.entryCount),
            active: String(runtime.messageCache.activeCount),
            hits: String(runtime.messageCache.hits),
            misses: String(runtime.messageCache.misses),
            evictions: String(runtime.messageCache.evictions),
            protected: String(runtime.messageCache.protectedOverbudget),
            largest: formatBytes(runtime.messageCache.entries[0]?.estimatedBytes ?? 0),
          })
        : i18n._(P.runtimeUnknown.id),
      tone: (runtime.messageCache?.protectedOverbudget ?? 0) > 0 ? "warning" : "default",
    },
    {
      label: P.runtimeLlmStreams,
      value: runtime.llmTurns
        ? i18n._(P.runtimeLlmStreamsValue.id, {
            streams: String(runtime.llmTurns.activeStreamCount),
            turns: String(runtime.llmTurns.activeTurnCount),
          })
        : i18n._(P.runtimeUnknown.id),
      tone: (runtime.llmTurns?.activeStreamCount ?? 0) > 0 ? "warning" : "default",
    },
  ]
}
