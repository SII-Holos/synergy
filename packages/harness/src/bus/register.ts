import { BusEvent } from "./bus-event"
import { Config } from "../config/config"
import { Scope } from "../scope"
import { Environment } from "../environment"
import { WorkspaceCatalog } from "../workspace/catalog"
import { Installation } from "../global/installation"
import { SessionEvent } from "../session/event"
import { SessionActivityEvent } from "../session/activity-events"
import { Todo } from "../session/todo"
import { Dag } from "../session/dag"
import { SessionInbox } from "../session/inbox"
import { MessageV2 } from "../session/message-v2"
import { SessionCompaction } from "../session/compaction"
import { SessionInputProgress } from "../session/input-progress"
import { RolloutEvents } from "../session/rollout/events"
import { CortexEvent } from "../cortex/event"
import { UsageLedger } from "../usage/ledger"
import { Permission } from "../permission"
import { PermissionNext } from "../permission/next"
import { ProviderAuthHealth } from "../provider/auth-health"
import { Bus } from "./index"

export function registerCoreEvents() {
  BusEvent.register(
    ...Object.values(Config.Event),
    ...Object.values(Scope.Event),
    ...Object.values(Environment.Event),
    ...Object.values(WorkspaceCatalog.Event),
    ...Object.values(Installation.Event),
    ...Object.values(SessionEvent),
    SessionActivityEvent.Execution,
    SessionActivityEvent.Tool,
    ...Object.values(Todo.Event),
    ...Object.values(Dag.Event),
    ...Object.values(SessionInbox.Event),
    ...Object.values(MessageV2.Event),
    ...Object.values(SessionCompaction.Event),
    ...Object.values(CortexEvent),
    Permission.Event.Updated,
    ...Object.values(PermissionNext.Event),
    ...Object.values(ProviderAuthHealth.Event),
    SessionInputProgress.Event,
    RolloutEvents.Updated,
    UsageLedger.Updated,
    Bus.ScopeRuntimeDisposed,
  )
}
