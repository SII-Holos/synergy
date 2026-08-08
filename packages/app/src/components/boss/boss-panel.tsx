import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { useLingui } from "@lingui/solid"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { copyTextToClipboard } from "@ericsanchezok/synergy-ui/clipboard"
import { useConfirm } from "@/components/dialog"
import type { SDKContext } from "@/context/sdk"
import { directIdleWorkers, flattenTree, renderTreeText, type BossTreeNodeVM } from "./boss-panel-model"

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

export function BossPanel(props: { sdk: SDKContext; sessionID: string }) {
  const { _ } = useLingui()
  const confirm = useConfirm()

  const [tree, setTree] = createSignal<BossTreeNodeVM | null>(null)
  const [loading, setLoading] = createSignal(true)
  const [loadError, setLoadError] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [spawnOpen, setSpawnOpen] = createSignal(false)
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
        setTree(node as BossTreeNodeVM)
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
    setLoading(true)
    setLoadError(undefined)
    void refreshTree(sessionID, token)
  })

  // Keep the panel live: refresh when sessions or messages change while the
  // panel is open so worker starts, completions, reports, and descendant
  // spawns update the tree without manual reloads.
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

  const rows = createMemo(() => (tree() ? flattenTree(tree()!) : []))

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
    if (result.ok) {
      showToast({ type: "info", title: _({ id: "app.boss.copy.title", message: "Tree copied" }) })
    }
  }

  return (
    <div class="flex size-full flex-col gap-3 overflow-auto p-3 text-12-regular text-text-base">
      <div class="flex items-center justify-between gap-2">
        <span class="text-13-medium text-text-strong">{_({ id: "app.boss.panel.title", message: "Boss Mode" })}</span>
        <div class="flex items-center gap-1.5">
          <Button size="small" variant="ghost" disabled={loading()} onClick={copyTree}>
            {_({ id: "app.boss.panel.copyTree", message: "Copy tree" })}
          </Button>
          <Button size="small" disabled={loading() || busy()} onClick={() => setSpawnOpen(true)}>
            {_({ id: "app.boss.panel.spawn", message: "Spawn worker" })}
          </Button>
        </div>
      </div>

      <Show when={loadError()}>
        <div class="rounded-lg bg-surface-raised-stronger p-3 text-12-regular text-text-on-critical-base">
          {loadError()}
        </div>
      </Show>

      <Show when={spawnOpen()}>
        <div class="flex flex-col gap-2 rounded-lg bg-surface-raised-stronger p-3">
          <input
            class="bg-transparent border-b border-border-interactive-base outline-none text-12-regular"
            placeholder={_({ id: "app.boss.spawn.rolePlaceholder", message: "Worker role (e.g. code)" })}
            value={spawnRole()}
            onInput={(e) => setSpawnRole(e.currentTarget.value)}
          />
          <input
            class="bg-transparent border-b border-border-interactive-base outline-none text-12-regular"
            placeholder={_({ id: "app.boss.spawn.agentPlaceholder", message: "Agent (e.g. synergy)" })}
            value={spawnAgent()}
            onInput={(e) => setSpawnAgent(e.currentTarget.value)}
          />
          <div class="flex justify-end gap-1.5">
            <Button size="small" variant="ghost" onClick={() => setSpawnOpen(false)}>
              {_({ id: "app.boss.spawn.cancel", message: "Cancel" })}
            </Button>
            <Button size="small" disabled={!spawnRole().trim() || busy()} onClick={spawnWorker}>
              {_({ id: "app.boss.spawn.create", message: "Create" })}
            </Button>
          </div>
        </div>
      </Show>

      <div class="flex flex-col gap-1.5 rounded-lg bg-surface-raised-stronger p-3">
        <span class="text-12-regular text-text-weak">
          {_({ id: "app.boss.assign.label", message: "Assign a task to an idle worker" })}
        </span>
        <select
          class="bg-transparent border-b border-border-interactive-base outline-none text-12-regular"
          value={assignTarget() ?? ""}
          onChange={(e) => setAssignTarget(e.currentTarget.value)}
        >
          <option value="" disabled>
            {_({ id: "app.boss.assign.selectWorker", message: "Select worker…" })}
          </option>
          <For
            each={directIdleWorkers(tree() ?? { sessionID: "", title: "", role: "boss", status: "idle", children: [] })}
          >
            {(worker) => (
              <option value={worker.sessionID}>
                {worker.title} ({worker.workerRole ?? "worker"})
              </option>
            )}
          </For>
        </select>
        <textarea
          class="bg-transparent border-b border-border-interactive-base outline-none text-12-regular resize-none"
          rows={2}
          placeholder={_({ id: "app.boss.assign.taskPlaceholder", message: "Task description…" })}
          value={assignTaskText()}
          onInput={(e) => setAssignTaskText(e.currentTarget.value)}
        />
        <div class="flex justify-end">
          <Button size="small" disabled={!assignTarget() || !assignTaskText().trim() || busy()} onClick={assignTask}>
            {_({ id: "app.boss.assign.submit", message: "Assign" })}
          </Button>
        </div>
      </div>

      <Show
        when={!loading() && tree()}
        fallback={
          <Show when={loading() && !loadError()} fallback={<div />}>
            <div class="flex items-center justify-center py-8">
              <Spinner />
            </div>
          </Show>
        }
      >
        <div class="flex flex-col gap-1">
          <For each={rows()}>
            {(row) => {
              const node = row.node
              const statusLabel =
                node.status === "running"
                  ? _({ id: "app.boss.status.running", message: "Running" })
                  : node.status === "queued"
                    ? _({ id: "app.boss.status.queued", message: "Queued" })
                    : node.status === "archived"
                      ? _({ id: "app.boss.status.archived", message: "Archived" })
                      : _({ id: "app.boss.status.idle", message: "Idle" })
              return (
                <div
                  class="flex items-center gap-2 rounded px-2 py-1 hover:bg-surface-raised-stronger"
                  style={{ "padding-left": `${8 + row.depth * 16}px` }}
                >
                  <span
                    class="size-1.5 shrink-0 rounded-full"
                    classList={{
                      "bg-icon-success-base": node.status === "running",
                      "bg-icon-warning-base": node.status === "idle" || node.status === "queued",
                      "bg-text-weaker": node.status === "archived",
                    }}
                  />
                  <span class="min-w-0 flex-1 truncate">
                    {node.role === "boss" ? (
                      <span class="text-12-medium text-text-strong">{node.title}</span>
                    ) : (
                      <>
                        <span class="text-12-regular">{node.title}</span>
                        <span class="text-11-regular text-text-weak">
                          {" "}
                          · {node.workerRole ?? "worker"}
                          {node.currentTask ? ` · ${node.currentTask.taskTitle ?? node.currentTask.taskID}` : ""}
                        </span>
                      </>
                    )}
                  </span>
                  <span class="shrink-0 text-11-regular text-text-weak" aria-label={statusLabel}>
                    {statusLabel}
                  </span>
                  <Show when={node.status !== "archived" && node.role === "worker"}>
                    <button
                      type="button"
                      class="text-11-regular text-text-weak hover:text-text-on-critical-base"
                      onClick={() => cancelWorker(node.sessionID)}
                    >
                      {_({ id: "app.boss.panel.cancel", message: "Cancel" })}
                    </button>
                  </Show>
                </div>
              )
            }}
          </For>
        </div>
      </Show>
    </div>
  )
}
