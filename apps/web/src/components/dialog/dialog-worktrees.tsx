import { createResource, createSignal, For, Show, onCleanup } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { WorktreeInventoryEntry } from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { sharedRequests } from "@/utils/shared-requests"
import { loadWorktreeInventory, worktreeInventoryKey } from "@/utils/worktree-inventory"
import { requestErrorMessage } from "@/utils/error"
import { useConfirm } from "./confirm-dialog"
import { projectEntryCopy as copy } from "./project-entry-copy"

export function DialogWorktrees(props: {
  scopeID: string
  inventoryVersion?: string
  onSelect?: (tree: WorktreeInventoryEntry) => Promise<void>
  disabled?: boolean
}) {
  const { _ } = useLingui()
  const sdk = useGlobalSDK()
  const confirm = useConfirm()
  const [error, setError] = createSignal("")
  const [pending, setPending] = createSignal("")
  const [expanded, setExpanded] = createSignal("")
  const lifetime = new AbortController()
  onCleanup(() => lifetime.abort())
  const [trees, { refetch }] = createResource(async () => {
    try {
      return (
        await loadWorktreeInventory(sdk.client, sdk.url, props.scopeID, props.inventoryVersion ?? "", lifetime.signal)
      ).data?.items
    } catch (failure) {
      setError(requestErrorMessage(failure, _(copy.unavailable)))
      return []
    }
  })
  async function remove(tree: WorktreeInventoryEntry) {
    if (
      !(await confirm.ask({
        title: copy.deleteWorktree,
        description: copy.deleteDescription,
        confirmLabel: copy.remove,
        tone: "warning",
      }))
    )
      return
    setPending(tree.id)
    setError("")
    try {
      await sdk.client.worktree.remove(
        { scopeID: props.scopeID, worktreeRemoveInput: { target: tree.id, sourceWorkspaceID: tree.sourceWorkspaceID } },
        { throwOnError: true },
      )
      sharedRequests.invalidate(worktreeInventoryKey(sdk.url, props.scopeID))
      await refetch()
    } catch (failure) {
      setError(requestErrorMessage(failure, _(copy.failed)))
    } finally {
      setPending("")
    }
  }
  return (
    <Dialog title={_(copy.worktrees)} size="list" class="project-settings-dialog">
      <div class="project-form">
        <Show when={error()}>
          <p role="alert" class="project-inline-error">
            {error()}{" "}
            <Button
              variant="ghost"
              onClick={() => {
                setError("")
                void refetch()
              }}
            >
              {_(copy.retry)}
            </Button>
          </p>
        </Show>
        <Show when={!trees.loading && !trees()?.length}>
          <p class="project-inline-note">{_(copy.emptyWorktrees)}</p>
        </Show>
        <For each={trees()}>
          {(tree) => (
            <div class="project-worktree-row">
              <Icon name={getSemanticIcon("workspace.worktree")} size="small" />
              <div class="project-flow-row-copy">
                <strong>{tree.branch ?? tree.name}</strong>
                <small>{tree.sourceDirectory}</small>
                <small>{_({ ...copy.using, values: { count: tree.bindings?.length ?? 0 } })}</small>
                <Show when={tree.setupFailed || tree.stale}>
                  <small>{tree.setupError ?? _(copy.stale)}</small>
                </Show>
                <Show when={expanded() === tree.id}>
                  <WorktreeDetails scopeID={props.scopeID} tree={tree} />
                </Show>
              </div>
              <Show when={props.onSelect}>
                <Button
                  variant="secondary"
                  disabled={props.disabled || !!pending() || tree.stale}
                  onClick={() => void props.onSelect?.(tree)}
                >
                  {_(copy.use)}
                </Button>
              </Show>
              <Button
                variant="ghost"
                aria-expanded={expanded() === tree.id}
                onClick={() => setExpanded(expanded() === tree.id ? "" : tree.id)}
              >
                {_(copy.details)}
              </Button>
              <Button variant="ghost" disabled={!!pending()} onClick={() => void remove(tree)}>
                {_(pending() === tree.id ? copy.loading : copy.remove)}
              </Button>
            </div>
          )}
        </For>
      </div>
    </Dialog>
  )
}

function WorktreeDetails(props: { scopeID: string; tree: WorktreeInventoryEntry }) {
  const sdk = useGlobalSDK()
  const { _, i18n } = useLingui()
  const lifetime = new AbortController()
  onCleanup(() => lifetime.abort())
  const [details] = createResource(async () => {
    const response = await sdk.client.project.worktreeDetails(
      { scopeID: props.scopeID, target: props.tree.id, sourceWorkspaceID: props.tree.sourceWorkspaceID },
      { signal: lifetime.signal, throwOnError: true },
    )
    return response.data
  })
  return (
    <Show when={!details.loading} fallback={<small>{_(copy.loading)}</small>}>
      <Show when={!details.error && details()?.state === "ready"} fallback={<small>{_(copy.unavailable)}</small>}>
        <small>{_(details()?.dirty ? copy.dirty : copy.clean)}</small>
        <small>
          {_({
            ...copy.diskSize,
            values: {
              size: new Intl.NumberFormat(i18n().locale, { maximumFractionDigits: 1 }).format(
                (details()?.diskBytes ?? 0) / 1024 / 1024,
              ),
            },
          })}
        </small>
        <small>
          {_({
            ...copy.checked,
            values: {
              time: new Intl.DateTimeFormat(i18n().locale, { timeStyle: "medium" }).format(details()?.computedAt),
            },
          })}
        </small>
      </Show>
    </Show>
  )
}
