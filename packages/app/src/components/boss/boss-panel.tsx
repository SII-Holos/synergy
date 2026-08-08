import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { DagGraph, type DagNode } from "@ericsanchezok/synergy-ui/dag-graph"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useLingui } from "@lingui/solid"
import { useConfirm } from "@/components/dialog"
import { useNavigateToSession } from "@/composables/use-navigate-to-session"
import type { SDKContext } from "@/context/sdk"
import {
  bossNodeLabel,
  bossTreePath,
  bossTreeToDagNodes,
  directIdleWorkers,
  flattenTree,
  renderTreeText,
  workerCount,
  type BossStatus,
  type BossTreeNodeVM,
} from "./boss-panel-model"

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function statusClasses(status: BossStatus): string {
  if (status === "running")
    return "bg-icon-success-base/12 text-icon-success-base ring-1 ring-inset ring-icon-success-base/15"
  if (status === "queued")
    return "bg-icon-warning-base/14 text-icon-warning-base ring-1 ring-inset ring-icon-warning-base/15"
  return "bg-surface-inset-base text-text-weak ring-1 ring-inset ring-border-base/40"
}

export function BossPanel(props: { sdk: SDKContext; sessionID: string }) {
  const { _ } = useLingui()
  const confirm = useConfirm()
  const navigateToSession = useNavigateToSession()

  const [tree, setTree] = createSignal<BossTreeNodeVM | null>(null)
  const [selectedSessionID, setSelectedSessionID] = createSignal(props.sessionID)
  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [spawnOpen, setSpawnOpen] = createSignal(false)
  const [assignOpen, setAssignOpen] = createSignal(false)
  const [spawnRole, setSpawnRole] = createSignal("code")
  const [spawnAgent, setSpawnAgent] = createSignal("synergy")
  const [assignTarget, setAssignTarget] = createSignal<string>()
  const [assignTaskText, setAssignTaskText] = createSignal("")
  let generation = 0

  const refreshTree = async (sessionID = props.sessionID, token = generation) => {
    try {
      const result = await props.sdk.client.boss.session.tree({ id: sessionID })
      const node = result.data?.tree
      if (!node) throw new Error("Boss tree returned no data")
      if (token === generation) {
        const nextTree = node as BossTreeNodeVM
        setTree(nextTree)
        if (!bossTreePath(nextTree, selectedSessionID())) setSelectedSessionID(nextTree.sessionID)
        setLoadError(undefined)
      }
    } catch (error) {
      if (token === generation) {
        setLoadError(
          errorMessage(error, _({ id: "app.boss.panel.loadFailed", message: "Failed to load the Boss tree." })),
        )
      }
    } finally {
      if (token === generation) setLoading(false)
    }
  }

  createEffect(() => {
    const sessionID = props.sessionID
    const token = ++generation
    setTree(null)
    setSelectedSessionID(sessionID)
    setLoading(true)
    setLoadError(undefined)
    void refreshTree(sessionID, token)
  })

  createEffect(() => {
    const sessionID = props.sessionID
    const unsubs = [
      props.sdk.event.on("session.updated", () => void refreshTree(sessionID)),
      props.sdk.event.on("message.updated", () => void refreshTree(sessionID)),
    ]
    onCleanup(() => {
      for (const unsub of unsubs) unsub()
    })
  })

  const dagNodes = createMemo(() => {
    const current = tree()
    return current ? bossTreeToDagNodes(current) : []
  })
  const nodesByID = createMemo(() => {
    const current = tree()
    return new Map(current ? flattenTree(current).map(({ node }) => [node.sessionID, node] as const) : [])
  })
  const selectedPath = createMemo(() => {
    const current = tree()
    return current ? bossTreePath(current, selectedSessionID()) : undefined
  })
  const selectedNode = createMemo(() => selectedPath()?.at(-1))
  const selectedParent = createMemo(() => selectedPath()?.at(-2))
  const directIdle = createMemo(() => {
    const current = tree()
    return current ? directIdleWorkers(current) : []
  })

  createEffect(() => {
    const target = assignTarget()
    if (target && !directIdle().some((worker) => worker.sessionID === target)) setAssignTarget(undefined)
  })

  const statusLabel = (status: BossStatus) => {
    if (status === "running") return _({ id: "app.boss.status.running", message: "Running" })
    if (status === "queued") return _({ id: "app.boss.status.queued", message: "Queued" })
    if (status === "archived") return _({ id: "app.boss.status.archived", message: "Archived" })
    return _({ id: "app.boss.status.idle", message: "Idle" })
  }

  const invoke = async (action: () => Promise<unknown>, successTitle: string, failureTitle: string) => {
    if (busy()) return
    setBusy(true)
    try {
      await action()
      await refreshTree()
      showToast({ type: "info", title: successTitle })
    } catch (error) {
      const message = errorMessage(error, _({ id: "app.boss.genericFailed", message: "The Boss action failed." }))
      showToast({ type: "error", title: failureTitle, description: message })
    } finally {
      setBusy(false)
    }
  }

  const spawnWorker = () => {
    const role = spawnRole().trim()
    if (!role) return
    void invoke(
      () =>
        props.sdk.client.boss.session.worker.create({
          id: props.sessionID,
          bossWorkerCreateInput: { role, agent: spawnAgent() },
        }),
      _({ id: "app.boss.spawn.success", message: "Worker spawned" }),
      _({ id: "app.boss.spawn.failed", message: "Failed to spawn worker" }),
    )
    setSpawnOpen(false)
  }

  const assignTask = () => {
    const target = assignTarget()
    const task = assignTaskText().trim()
    if (!target || !task) return
    void invoke(
      () =>
        props.sdk.client.boss.session.worker.assign({
          id: props.sessionID,
          bossWorkerAssignInput: {
            sessionID: target,
            taskID: `task-${Date.now().toString(36)}`,
            task,
          },
        }),
      _({ id: "app.boss.assign.success", message: "Task assigned" }),
      _({ id: "app.boss.assign.failed", message: "Failed to assign task" }),
    )
    setAssignTaskText("")
    setAssignOpen(false)
  }

  const cancelWorker = (sessionID: string) => {
    confirm.show({
      title: { id: "app.boss.cancel.confirmTitle", message: "Cancel this worker's work?" },
      description: {
        id: "app.boss.cancel.confirmDescription",
        message: "Pending tasks will be removed and a running turn will be interrupted.",
      },
      confirmLabel: { id: "app.boss.cancel.confirm", message: "Cancel work" },
      cancelLabel: { id: "app.boss.cancel.cancel", message: "Keep" },
      tone: "danger",
      onConfirm: () =>
        void invoke(
          () =>
            props.sdk.client.boss.session.worker.cancel({
              id: props.sessionID,
              bossWorkerCancelInput: { sessionID },
            }),
          _({ id: "app.boss.cancel.success", message: "Work cancelled" }),
          _({ id: "app.boss.cancel.failed", message: "Failed to cancel work" }),
        ),
    })
  }

  const copyTree = async () => {
    const current = tree()
    if (!current) return
    const result = await copyTextToClipboard(renderTreeText(current), {
      label: _({ id: "app.boss.copy.title", message: "Tree copied" }),
      failureDescription: _({ id: "app.boss.copy.failed", message: "Failed to copy the Boss tree." }),
    })
    if (result.ok) showToast({ type: "info", title: _({ id: "app.boss.copy.title", message: "Tree copied" }) })
  }

  const openSelectedSession = () => {
    const node = selectedNode()
    if (!node) return
    navigateToSession(node.sessionID)
  }

  const dagStatusLabel = (node: DagNode) => statusLabel(nodesByID().get(node.id)?.status ?? "idle")
  const dagNodeAriaLabel = (node: DagNode) => `${node.content}, ${dagStatusLabel(node)}`

  return (
    <div class="@container flex size-full min-h-0 flex-col overflow-hidden text-12-regular text-text-base">
      <header class="flex shrink-0 items-center justify-between gap-3 border-b border-border-weak-base px-3 py-2.5">
        <div class="flex min-w-0 items-center gap-2">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-raised-stronger-non-alpha text-icon-warning-base">
            <Icon name={getSemanticIcon("prompt.boss")} size="small" />
          </span>
          <div class="min-w-0">
            <div class="truncate text-13-medium text-text-strong">
              {_({ id: "app.boss.panel.title", message: "Boss Mode" })}
            </div>
            <Show when={tree()}>
              {(current) => (
                <div class="text-10-regular text-text-weaker">
                  {_({
                    id: "app.boss.panel.workerCount",
                    message: "{count, plural, one {# worker} other {# workers}}",
                    values: { count: workerCount(current()) },
                  })}
                </div>
              )}
            </Show>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <Button
            size="small"
            variant="ghost"
            icon={getSemanticIcon("action.copy")}
            disabled={loading()}
            aria-label={_({ id: "app.boss.panel.copyTree", message: "Copy tree" })}
            title={_({ id: "app.boss.panel.copyTree", message: "Copy tree" })}
            onClick={copyTree}
          />
          <Button size="small" disabled={loading() || busy()} onClick={() => setSpawnOpen((value) => !value)}>
            {_({ id: "app.boss.panel.spawn", message: "Spawn worker" })}
          </Button>
        </div>
      </header>

      <Show when={loadError()}>
        <div class="m-3 rounded-lg bg-surface-critical-weak p-3 text-12-regular text-text-on-critical-base">
          {loadError()}
        </div>
      </Show>

      <Show when={spawnOpen()}>
        <div class="shrink-0 border-b border-border-weak-base bg-surface-raised-base px-3 py-3">
          <div class="grid gap-2 @md:grid-cols-2">
            <label class="flex flex-col gap-1 text-10-medium text-text-weak">
              {_({ id: "app.boss.spawn.roleLabel", message: "Worker role" })}
              <input
                class="h-8 rounded-lg border border-border-base bg-surface-base px-2 text-12-regular text-text-strong outline-none focus:border-border-interactive-base"
                placeholder={_({ id: "app.boss.spawn.rolePlaceholder", message: "Worker role (e.g. code)" })}
                value={spawnRole()}
                onInput={(event) => setSpawnRole(event.currentTarget.value)}
              />
            </label>
            <label class="flex flex-col gap-1 text-10-medium text-text-weak">
              {_({ id: "app.boss.spawn.agentLabel", message: "Agent" })}
              <input
                class="h-8 rounded-lg border border-border-base bg-surface-base px-2 text-12-regular text-text-strong outline-none focus:border-border-interactive-base"
                placeholder={_({ id: "app.boss.spawn.agentPlaceholder", message: "Agent (e.g. synergy)" })}
                value={spawnAgent()}
                onInput={(event) => setSpawnAgent(event.currentTarget.value)}
              />
            </label>
          </div>
          <div class="mt-2 flex justify-end gap-1.5">
            <Button size="small" variant="ghost" onClick={() => setSpawnOpen(false)}>
              {_({ id: "app.boss.spawn.cancel", message: "Cancel" })}
            </Button>
            <Button size="small" disabled={!spawnRole().trim() || busy()} onClick={spawnWorker}>
              {_({ id: "app.boss.spawn.create", message: "Create" })}
            </Button>
          </div>
        </div>
      </Show>

      <Show
        when={!loading() && tree() && dagNodes().length > 0}
        fallback={
          <Show when={loading() && !loadError()}>
            <div class="flex flex-1 items-center justify-center py-8">
              <Spinner />
            </div>
          </Show>
        }
      >
        <div class="grid min-h-0 flex-1 grid-rows-[minmax(300px,1fr)_auto] overflow-auto">
          <section class="min-h-0 overflow-hidden border-b border-border-weak-base bg-surface-base">
            <DagGraph
              nodes={dagNodes()}
              variant="panel"
              showStats={false}
              enableInspector={false}
              selectedNodeId={selectedSessionID()}
              onSelectNode={(node) => setSelectedSessionID(node.id)}
              getStatusLabel={dagStatusLabel}
              getNodeAriaLabel={dagNodeAriaLabel}
            />
          </section>

          <aside class="max-h-[42vh] overflow-auto bg-surface-raised-stronger-non-alpha px-4 py-4">
            <Show when={selectedNode()}>
              {(nodeAccessor) => {
                const node = () => nodeAccessor()
                return (
                  <div>
                    <div class="flex flex-wrap items-center gap-1 text-9-regular text-text-weaker">
                      <For each={selectedPath()}>
                        {(part, index) => (
                          <>
                            <Show when={index() > 0}>
                              <span aria-hidden="true">/</span>
                            </Show>
                            <span class="max-w-40 truncate">{bossNodeLabel(part)}</span>
                          </>
                        )}
                      </For>
                    </div>

                    <div class="mt-3 grid gap-4 @xl:grid-cols-[minmax(180px,0.7fr)_minmax(220px,0.8fr)_minmax(260px,1.5fr)_auto] @xl:items-start">
                      <div class="flex min-w-0 items-start gap-3">
                        <span
                          class="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-raised-base text-11-semibold text-text-strong"
                          classList={{ "text-icon-warning-base": node().role === "boss" }}
                        >
                          {node().role === "boss" ? (
                            <Icon name={getSemanticIcon("prompt.boss")} size="normal" />
                          ) : (
                            bossNodeLabel(node())
                              .split(/[\s_-]+/)
                              .filter(Boolean)
                              .slice(0, 2)
                              .map((part) => part[0]?.toUpperCase())
                              .join("")
                          )}
                        </span>
                        <div class="min-w-0 flex-1">
                          <span
                            class={`inline-flex rounded-full px-2 py-0.5 text-9-medium ${statusClasses(node().status)}`}
                          >
                            {statusLabel(node().status)}
                          </span>
                          <h2 class="mt-1 truncate text-16-medium text-text-strong">{bossNodeLabel(node())}</h2>
                          <div class="mt-0.5 text-10-regular text-text-weaker">
                            {node().role === "boss"
                              ? _({ id: "app.boss.panel.orchestrator", message: "Orchestrator" })
                              : _({
                                  id: "app.boss.panel.depth",
                                  message: "Worker at depth {depth}",
                                  values: { depth: selectedPath()!.length - 1 },
                                })}
                          </div>
                        </div>
                      </div>

                      <dl class="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-2 text-11-regular">
                        <dt class="text-text-weaker">{_({ id: "app.boss.panel.agent", message: "Agent" })}</dt>
                        <dd class="truncate text-text-strong">
                          {node().agent || _({ id: "app.boss.panel.notAvailable", message: "Not available" })}
                        </dd>
                        <Show when={selectedParent()}>
                          {(parent) => (
                            <>
                              <dt class="text-text-weaker">
                                {_({ id: "app.boss.panel.reportsTo", message: "Reports to" })}
                              </dt>
                              <dd class="truncate text-text-strong">{bossNodeLabel(parent())}</dd>
                            </>
                          )}
                        </Show>
                        <dt class="text-text-weaker">{_({ id: "app.boss.panel.children", message: "Children" })}</dt>
                        <dd class="text-text-strong">{node().children.length}</dd>
                      </dl>

                      <div class="min-w-0">
                        <div class="text-10-medium text-text-weak">
                          {_({ id: "app.boss.panel.currentTask", message: "Current task" })}
                        </div>
                        <div class="mt-1 max-h-24 overflow-auto text-11-regular leading-relaxed text-text-base">
                          {node().currentTask?.taskTitle ||
                            node().currentTask?.taskID ||
                            _({ id: "app.boss.panel.noTask", message: "No task is currently assigned." })}
                        </div>
                      </div>

                      <div class="flex flex-wrap items-center gap-1.5 @xl:justify-end">
                        <Button
                          size="small"
                          variant="primary"
                          icon={getSemanticIcon("action.open")}
                          onClick={openSelectedSession}
                        >
                          {_({ id: "app.boss.panel.openSession", message: "Open session" })}
                        </Button>
                        <Show when={node().role === "worker" && node().status !== "archived"}>
                          <Button
                            size="small"
                            variant="ghost"
                            disabled={busy()}
                            onClick={() => cancelWorker(node().sessionID)}
                          >
                            {_({ id: "app.boss.panel.cancel", message: "Cancel" })}
                          </Button>
                        </Show>
                      </div>
                    </div>
                  </div>
                )
              }}
            </Show>

            <Show when={directIdle().length > 0}>
              <div class="mt-4 border-t border-border-weak-base pt-3">
                <Button size="small" variant="ghost" onClick={() => setAssignOpen((value) => !value)}>
                  {_({ id: "app.boss.assign.label", message: "Assign a task to an idle worker" })}
                </Button>
                <Show when={assignOpen()}>
                  <div class="mt-2 grid gap-2 @md:grid-cols-[minmax(160px,0.7fr)_minmax(240px,1.5fr)_auto]">
                    <select
                      class="h-8 rounded-lg border border-border-base bg-surface-base px-2 text-11-regular text-text-strong outline-none focus:border-border-interactive-base"
                      value={assignTarget() ?? ""}
                      onChange={(event) => setAssignTarget(event.currentTarget.value)}
                    >
                      <option value="" disabled>
                        {_({ id: "app.boss.assign.selectWorker", message: "Select worker…" })}
                      </option>
                      <For each={directIdle()}>
                        {(worker) => (
                          <option value={worker.sessionID}>
                            {bossNodeLabel(worker)} ({worker.workerRole ?? "worker"})
                          </option>
                        )}
                      </For>
                    </select>
                    <textarea
                      class="min-h-8 resize-none rounded-lg border border-border-base bg-surface-base px-2 py-1.5 text-11-regular text-text-strong outline-none placeholder:text-text-weaker focus:border-border-interactive-base"
                      placeholder={_({ id: "app.boss.assign.taskPlaceholder", message: "Task description…" })}
                      value={assignTaskText()}
                      onInput={(event) => setAssignTaskText(event.currentTarget.value)}
                    />
                    <Button
                      size="small"
                      disabled={!assignTarget() || !assignTaskText().trim() || busy()}
                      onClick={assignTask}
                    >
                      {_({ id: "app.boss.assign.submit", message: "Assign" })}
                    </Button>
                  </div>
                </Show>
              </div>
            </Show>
          </aside>
        </div>
      </Show>
    </div>
  )
}
