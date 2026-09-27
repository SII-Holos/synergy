import { registerConfigMigrations } from "../config/migration"
import { registerScopeMigrations } from "../scope/migration"
import { registerSessionMigrations } from "../session/migration"
import { registerObservabilityMigrations } from "../observability/migration"
import { registerStorageMigrations } from "../storage/migration"
import { registerSessionResolver } from "../session/index"
import { registerSummaryJob } from "../session/summary"
import { registerTitleJob } from "../session/title"
import { registerLoopSignals } from "../session/loop-signals"
import { SessionCompaction } from "../session/compaction"
import { registerSearchFailureAnalyzer } from "../tool/search-guard"
import { ObservabilityMetrics } from "../observability/metrics"
import { RuntimeContext } from "./context"
import { Environment } from "../environment"
import { registerEnvironmentMigrations } from "../environment/migration"
import { registerWorkspaceMigrations } from "../workspace/migration"
import { WorkspaceMounts } from "../workspace/mount"
import { EnvironmentExecution } from "../environment/execution"

const registration = RuntimeContext.state(() => ({ complete: false }))

export function registerHarness() {
  const state = registration()
  if (state.complete) return
  registerConfigMigrations()
  registerScopeMigrations()
  registerSessionMigrations()
  registerObservabilityMigrations()
  registerStorageMigrations()
  registerWorkspaceMigrations()
  registerEnvironmentMigrations()
  Environment.registerRecovery()
  WorkspaceMounts.register()
  EnvironmentExecution.registerRecovery()
  registerSessionResolver()
  registerSummaryJob()
  registerTitleJob()
  registerLoopSignals()
  SessionCompaction.registerJobs()
  registerSearchFailureAnalyzer()
  ObservabilityMetrics.register()
  state.complete = true
}
