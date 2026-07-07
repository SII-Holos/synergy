import { createResource, For, Show } from "solid-js"
import type { IconName } from "@ericsanchezok/synergy-ui/icon"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Panel } from "@/components/panel"
import { useGlobalSDK } from "@/context/global-sdk"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

type DiagnosticsSummary = {
  generatedAt?: string
  logs?: {
    dev?: string
    daemon?: string
    devArchives?: string[]
  }
  traces?: {
    directory?: string
    files?: string[]
    recentErrors?: unknown[]
  }
  lock?: {
    lock?: { pid?: number; mode?: string; cwd?: string }
    inspection?: {
      alive?: boolean
      healthy?: boolean
      ppid?: number
      cpu?: number
      elapsed?: string
      listeningPorts?: number[]
      command?: string
    }
  }
  processes?: {
    active?: unknown[]
    finished?: unknown[]
  }
  sessions?: {
    pendingReply?: Array<{ sessionID?: string; updated?: number }>
  }
}

export function DiagnosticsPanel() {
  const globalSDK = useGlobalSDK()
  const [summary, { refetch }] = createResource(async () => {
    const result = await globalSDK.client.observability.diagnostics.summary()
    return result.data as DiagnosticsSummary
  })

  return (
    <Panel.Root>
      <Panel.Header>
        <Panel.HeaderRow>
          <Panel.Title>Diagnostics</Panel.Title>
          <Panel.Actions>
            <Panel.Action icon={getSemanticIcon("action.refresh")} title="Refresh" onClick={() => refetch()} />
          </Panel.Actions>
        </Panel.HeaderRow>
      </Panel.Header>

      <Show when={!summary.loading} fallback={<Panel.Loading />}>
        <Panel.Body>
          <div class="flex flex-col gap-3">
            <SummaryGrid summary={summary()} />
            <RuntimeLock summary={summary()} />
            <RecentErrors summary={summary()} />
            <PendingSessions summary={summary()} />
            <Paths summary={summary()} />
          </div>
        </Panel.Body>
      </Show>
    </Panel.Root>
  )
}

function SummaryGrid(props: { summary?: DiagnosticsSummary }) {
  const errors = () => props.summary?.traces?.recentErrors?.length ?? 0
  const pending = () => props.summary?.sessions?.pendingReply?.length ?? 0
  const active = () => props.summary?.processes?.active?.length ?? 0
  const traces = () => props.summary?.traces?.files?.length ?? 0
  return (
    <div class="grid grid-cols-2 gap-2">
      <Metric label="Errors" value={errors()} tone={errors() > 0 ? "warning" : "default"} />
      <Metric label="Pending" value={pending()} tone={pending() > 0 ? "warning" : "default"} />
      <Metric label="Processes" value={active()} tone={active() > 0 ? "active" : "default"} />
      <Metric label="Trace files" value={traces()} />
    </div>
  )
}

function Metric(props: { label: string; value: number; tone?: "default" | "warning" | "active" }) {
  return (
    <div class="rounded-lg border border-border-weaker-base bg-surface-raised-base p-3">
      <div
        classList={{
          "text-20-medium": true,
          "text-text-strong": !props.tone || props.tone === "default",
          "text-icon-warning-base": props.tone === "warning",
          "text-icon-accent-base": props.tone === "active",
        }}
      >
        {props.value}
      </div>
      <div class="text-11-regular text-text-weaker mt-0.5">{props.label}</div>
    </div>
  )
}

function RuntimeLock(props: { summary?: DiagnosticsSummary }) {
  const lock = () => props.summary?.lock?.lock
  const inspection = () => props.summary?.lock?.inspection
  return (
    <Section title="Runtime Lock" icon={getSemanticIcon("providers.main")}>
      <Show
        when={lock()}
        fallback={<div class="text-12-regular text-text-weaker px-0.5 py-1">No runtime lock present</div>}
      >
        {(item) => (
          <div class="flex flex-col gap-2 text-12-regular">
            <Row label="PID" value={String(item().pid ?? "-")} />
            <Row label="Mode" value={item().mode ?? "-"} />
            <Row label="Alive" value={String(inspection()?.alive ?? "unknown")} />
            <Row label="Healthy" value={String(inspection()?.healthy ?? "unknown")} />
            <Row label="CPU" value={inspection()?.cpu === undefined ? "-" : `${inspection()!.cpu}%`} />
            <Show when={inspection()?.listeningPorts?.length}>
              <Row label="Ports" value={inspection()!.listeningPorts!.join(", ")} />
            </Show>
            <Show when={item().cwd}>
              <PathLine value={item().cwd!} />
            </Show>
          </div>
        )}
      </Show>
    </Section>
  )
}

function RecentErrors(props: { summary?: DiagnosticsSummary }) {
  const errors = () => props.summary?.traces?.recentErrors ?? []
  return (
    <Section title="Recent Errors" icon={getSemanticIcon("state.warning")}>
      <Show when={errors().length > 0} fallback={<div class="text-12-regular text-text-weaker">No recent errors</div>}>
        <div class="flex flex-col gap-2">
          <For each={errors().slice(0, 5)}>
            {(event) => {
              const item = event as { iso?: string; type?: string; sessionID?: string; callID?: string }
              return (
                <div class="rounded-lg bg-surface-inset-base/60 p-2.5">
                  <div class="text-12-medium text-text-strong truncate">{item.type ?? "error"}</div>
                  <div class="text-11-regular text-text-weaker truncate">{item.iso ?? ""}</div>
                  <Show when={item.sessionID || item.callID}>
                    <div class="text-11-regular text-text-weaker truncate">
                      {[item.sessionID, item.callID].filter(Boolean).join(" / ")}
                    </div>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </Section>
  )
}

function PendingSessions(props: { summary?: DiagnosticsSummary }) {
  const sessions = () => props.summary?.sessions?.pendingReply ?? []
  return (
    <Section title="Pending Sessions" icon={getSemanticIcon("settings.timeouts")}>
      <Show
        when={sessions().length > 0}
        fallback={<div class="text-12-regular text-text-weaker">No pending replies</div>}
      >
        <div class="flex flex-col gap-2">
          <For each={sessions().slice(0, 5)}>
            {(session) => (
              <div class="flex items-center gap-2 rounded-lg bg-surface-inset-base/60 p-2.5">
                <Icon name={getSemanticIcon("session.default")} size="small" class="text-icon-weak shrink-0" />
                <div class="min-w-0 flex-1">
                  <div class="text-12-medium text-text-strong truncate">{session.sessionID ?? "session"}</div>
                  <div class="text-11-regular text-text-weaker">{formatTime(session.updated)}</div>
                </div>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Section>
  )
}

function Paths(props: { summary?: DiagnosticsSummary }) {
  return (
    <Section title="Files" icon={getSemanticIcon("settings.configFiles")}>
      <div class="flex flex-col gap-2">
        <Show when={props.summary?.logs?.dev}>
          <PathLine label="Dev log" value={props.summary!.logs!.dev!} />
        </Show>
        <Show when={props.summary?.logs?.daemon}>
          <PathLine label="Daemon log" value={props.summary!.logs!.daemon!} />
        </Show>
        <Show when={props.summary?.traces?.directory}>
          <PathLine label="Trace dir" value={props.summary!.traces!.directory!} />
        </Show>
      </div>
    </Section>
  )
}

function Section(props: { title: string; icon: IconName; children: any }) {
  return (
    <div class="rounded-lg border border-border-weaker-base bg-surface-base p-3.5">
      <div class="flex items-center gap-2 mb-3">
        <Icon name={props.icon} size="small" class="text-icon-weak" />
        <span class="text-12-medium text-text-strong">{props.title}</span>
      </div>
      {props.children}
    </div>
  )
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="flex items-center justify-between gap-3">
      <span class="text-text-weaker">{props.label}</span>
      <span class="text-text-base truncate">{props.value}</span>
    </div>
  )
}

function PathLine(props: { label?: string; value: string }) {
  return (
    <div class="min-w-0">
      <Show when={props.label}>
        <div class="text-11-medium text-text-weaker mb-1">{props.label}</div>
      </Show>
      <div class="rounded-md bg-surface-inset-base/70 px-2 py-1.5 text-11-regular text-text-weak break-all">
        {props.value}
      </div>
    </div>
  )
}

function formatTime(value?: number) {
  if (!value) return "-"
  return new Date(value).toLocaleString()
}
