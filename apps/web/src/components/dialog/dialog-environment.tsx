import { IconButton } from "@ericsanchezok/synergy-ui/icon-button"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { locationCopy } from "./task-location-copy"
import "./project-flow.css"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { EnvironmentActivity, EnvironmentInfo, ResourceProfiles } from "@ericsanchezok/synergy-sdk/client"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { useLingui } from "@lingui/solid"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import { requestErrorMessage } from "@/utils/error"
import { useConfirm } from "./confirm-dialog"
import { environmentCopy as copy } from "./environment-dialog-copy"

export function DialogEnvironment(props: {
  sessionID?: string
  selection?: string | null
  onSelect?: (environmentID: string | null | undefined) => void
}) {
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const confirm = useConfirm()
  const { _ } = useLingui()
  const scopeID = sdk.scopeID
  const client = sdk.client
  const controller = new AbortController()
  const options = { signal: controller.signal, throwOnError: true as const }
  const initial = props.sessionID ? (sync.session.get(props.sessionID)?.environmentID ?? null) : props.selection
  const [selected, setSelected] = createSignal(initial)
  const [baseline, setBaseline] = createSignal(initial ?? null)
  const [records, setRecords] = createStore<{ data: EnvironmentInfo[]; activity: Record<string, EnvironmentActivity> }>(
    { data: [], activity: {} },
  )
  const [profiles, setProfiles] = createSignal<ResourceProfiles>()
  const [loading, setLoading] = createSignal(true)
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal("")
  const [activityError, setActivityError] = createSignal("")
  const [activityLoading, setActivityLoading] = createSignal(false)
  const requests = new Map<string, string>()
  let activityRequest = 0
  const record = createMemo(() => records.data.find((item) => item.id === selected()))
  const activity = createMemo(() => {
    const id = selected()
    const value = id ? records.activity[id] : undefined
    return value?.environment.generation === record()?.generation ? value : undefined
  })
  onCleanup(() => controller.abort())
  createEffect(() => {
    if (sdk.scopeID !== scopeID || sdk.client !== client) dialog.close()
  })
  function upsert(item: EnvironmentInfo) {
    if (controller.signal.aborted || item.scopeID !== scopeID) return
    const index = records.data.findIndex((row) => row.id === item.id)
    if (index < 0) setRecords("data", records.data.length, item)
    else if (records.data[index]!.updatedAt <= item.updatedAt) setRecords("data", index, reconcile(item))
  }
  async function perform(action: () => Promise<void>) {
    if (pending() || controller.signal.aborted) return
    setPending(true)
    setError("")
    try {
      await action()
    } catch (error) {
      if (!controller.signal.aborted) setError(requestErrorMessage(error, _(copy.failed)))
    } finally {
      if (!controller.signal.aborted) setPending(false)
    }
  }
  async function reload() {
    await perform(async () => {
      const results = await Promise.allSettled([
        client.environment.list({ scopeID }, options).then((result) => {
          for (const row of result.data) upsert(row)
        }),
        client.environment.profiles({ scopeID }, options).then((result) => {
          if (!controller.signal.aborted) setProfiles(result.data)
        }),
        props.sessionID
          ? client.session.get({ scopeID, sessionID: props.sessionID }, options).then((result) => {
              if (!controller.signal.aborted) setBaseline(result.data.environmentID ?? null)
            })
          : Promise.resolve(),
      ])
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    })
    if (!controller.signal.aborted) setLoading(false)
  }
  async function refresh(id = selected()) {
    const request = ++activityRequest
    setActivityError("")
    if (!id) {
      setActivityLoading(false)
      return
    }
    setActivityLoading(true)
    try {
      const result = await client.environment.activity({ scopeID, environmentID: id }, options)
      if (controller.signal.aborted || request !== activityRequest) return
      upsert(result.data.environment)
      setRecords("activity", id, reconcile(result.data))
    } catch (error) {
      if (!controller.signal.aborted && request === activityRequest)
        setActivityError(requestErrorMessage(error, _(copy.failed)))
    } finally {
      if (!controller.signal.aborted && request === activityRequest) setActivityLoading(false)
    }
  }
  createEffect(() => {
    void refresh(selected())
  })
  onMount(() => {
    void reload()
  })
  onCleanup(sdk.event.on("environment.updated", (event) => upsert(structuredClone(event.properties))))
  const create = (profile: string) =>
    perform(async () => {
      const requestID = requests.get(profile) ?? generateUUID()
      requests.set(profile, requestID)
      const result = await client.environment.create({ scopeID, profile, requestID }, options)
      upsert(result.data)
      if (!controller.signal.aborted) setSelected(result.data.id)
    })
  const choose = () =>
    perform(async () => {
      const id = selected()
      if (id && !record()) return
      if (props.sessionID)
        await client.session.setEnvironment(
          {
            scopeID,
            sessionID: props.sessionID,
            sessionEnvironmentSelection: { environmentID: id ?? null, expectedEnvironmentID: baseline() },
          },
          options,
        )
      if (controller.signal.aborted) return
      props.onSelect?.(id)
      dialog.close()
    })
  const mutate = (action: (item: EnvironmentInfo) => Promise<unknown>) =>
    perform(async () => {
      const item = record()
      if (!item) return
      await action(item)
      await refresh(item.id)
    })
  const cancel = async (environmentID: string, operationID: string) => {
    if (
      !(await confirm.ask({
        title: copy.cancel,
        description: copy.cancelDescription,
        confirmLabel: copy.cancel,
        tone: "danger",
      }))
    )
      return
    await perform(async () => {
      await client.environment.cancelExecution({ scopeID, environmentID, operationID }, options)
      await refresh(environmentID)
    })
  }
  return (
    <Dialog
      title={_(locationCopy.manageExecution)}
      description={_(copy.description)}
      footer={
        <div data-slot="dialog-actions">
          <Button variant="ghost" disabled={pending()} onClick={reload}>
            {_(copy.reload)}
          </Button>
          <Button variant="ghost" disabled={pending()} onClick={() => dialog.close()}>
            {_(copy.close)}
          </Button>
          <Button variant="primary" disabled={pending() || loading() || (!!selected() && !record())} onClick={choose}>
            {_(copy.choose)}
          </Button>
        </div>
      }
      size="form"
      dismissible={!pending()}
      action={
        <IconButton
          icon={getSemanticIcon("action.close")}
          aria-label={_(locationCopy.cancel)}
          disabled={pending()}
          onClick={() => dialog.close()}
        />
      }
    >
      <div data-slot="dialog-form" class="project-flow">
        <Show when={loading()}>
          <p role="status">{_(copy.loading)}</p>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Show when={!props.sessionID}>
            <Button
              variant={selected() === undefined ? "secondary" : "ghost"}
              aria-pressed={selected() === undefined}
              disabled={pending()}
              onClick={() => setSelected(undefined)}
            >
              {_(copy.default)}
            </Button>
          </Show>
          <Button
            variant={selected() === null ? "secondary" : "ghost"}
            aria-pressed={selected() === null}
            disabled={pending()}
            onClick={() => setSelected(null)}
          >
            {_(copy.none)}
          </Button>
        </div>
        <Show when={profiles()?.environments.length}>
          <fieldset class="flex flex-wrap gap-2" disabled={pending()}>
            <legend class="text-small text-text-weak">{_(copy.profiles)}</legend>
            <For each={profiles()?.environments}>
              {(profile) => <Button onClick={() => create(profile.name)}>{profile.name}</Button>}
            </For>
          </fieldset>
        </Show>
        <div class="project-flow-list" aria-label={_(copy.existing)}>
          <For each={records.data}>
            {(item) => (
              <Button
                class="project-flow-row h-auto justify-between whitespace-normal break-all text-left"
                variant={selected() === item.id ? "secondary" : "ghost"}
                aria-pressed={selected() === item.id}
                disabled={pending()}
                onClick={() => setSelected(item.id)}
              >
                <span>
                  {item.provider} · {item.id.slice(-8)}
                </span>
                <span class="text-small text-text-weak">{_({ ...copy.state, values: { state: item.state } })}</span>
              </Button>
            )}
          </For>
          <Show when={!loading() && !records.data.length}>
            <p class="text-small text-text-weak">{_(copy.empty)}</p>
          </Show>
        </div>
        <Show when={record()}>
          {(item) => (
            <section class="flex flex-col gap-2" aria-label={_(copy.activity)}>
              <details>
                <summary class="cursor-pointer text-small">{_(copy.details)}</summary>
                <p class="text-small break-all">{item().id}</p>
              </details>
              <Show when={activityLoading()}>
                <p role="status">{_(copy.activityLoading)}</p>
              </Show>
              <Show when={activity()}>
                {(current) => (
                  <>
                    <p class="text-small text-text-weak">
                      {_({ ...copy.activeUses, values: { count: current().uses.length } })}
                    </p>
                    <Show when={current().executions.length || current().files.length}>
                      <p class="text-small text-text-weak">{_(copy.recoverDescription)}</p>
                    </Show>
                    <For each={current().executions}>
                      {(execution) => (
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="text-small">{_({ ...copy.operation, values: { state: execution.state } })}</span>
                          <Button
                            disabled={pending()}
                            onClick={() =>
                              mutate((item) =>
                                client.environment.recoverExecution(
                                  { scopeID, environmentID: item.id, operationID: execution.id },
                                  options,
                                ),
                              )
                            }
                          >
                            {_(copy.recover)}
                          </Button>
                          <Show
                            when={["submitted", "running", "cancel_requested", "unknown"].includes(execution.state)}
                          >
                            <Button
                              variant="ghost"
                              disabled={pending()}
                              onClick={() => cancel(item().id, execution.id)}
                            >
                              {_(copy.cancel)}
                            </Button>
                          </Show>
                        </div>
                      )}
                    </For>
                    <For each={current().files}>
                      {(operation) => (
                        <div class="flex flex-wrap items-center gap-2">
                          <span class="text-small">{_({ ...copy.operation, values: { state: operation.state } })}</span>
                          <Button
                            disabled={pending()}
                            onClick={() =>
                              mutate((item) =>
                                client.environment.recoverFile(
                                  { scopeID, environmentID: item.id, operationID: operation.id },
                                  options,
                                ),
                              )
                            }
                          >
                            {_(copy.recover)}
                          </Button>
                        </div>
                      )}
                    </For>
                  </>
                )}
              </Show>
              <Show when={activityError()}>
                <p role="alert" class="text-small text-text-error break-words">
                  {activityError()}
                </p>
              </Show>
              <div class="flex flex-wrap gap-2">
                <Button variant="ghost" disabled={pending() || activityLoading()} onClick={() => refresh()}>
                  {_(copy.refresh)}
                </Button>
                <Button
                  variant="ghost"
                  disabled={pending()}
                  onClick={() =>
                    mutate((item) => client.environment.reconcile({ scopeID, environmentID: item.id }, options))
                  }
                >
                  {_(copy.reconcile)}
                </Button>
                <Show when={item().ownership === "managed" && item().state !== "idle"}>
                  <Button
                    variant="ghost"
                    disabled={pending() || !activity() || !!activity()?.uses.length}
                    onClick={() =>
                      mutate((item) =>
                        client.environment.release(
                          { scopeID, environmentID: item.id, expectedGeneration: item.generation },
                          options,
                        ),
                      )
                    }
                  >
                    {_(copy.release)}
                  </Button>
                </Show>
              </div>
            </section>
          )}
        </Show>
        <Show when={error()}>
          <p role="alert" class="text-small text-text-error break-words">
            {error()}
          </p>
        </Show>
      </div>
    </Dialog>
  )
}
