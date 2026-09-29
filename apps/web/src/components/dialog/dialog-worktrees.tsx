import { createResource, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import type { Worktree } from "@ericsanchezok/synergy-sdk/client"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { useGlobalSDK } from "@/context/global-sdk"
import { requestErrorMessage } from "@/utils/error"
import { useConfirm } from "./confirm-dialog"
import { projectEntryCopy as copy } from "./project-entry-copy"

export function DialogWorktrees(props: {
  scopeID: string
  onSelect?: (tree: Worktree) => Promise<void>
  disabled?: boolean
}) {
  const { _ } = useLingui()
  const sdk = useGlobalSDK()
  const confirm = useConfirm()
  const [error, setError] = createSignal("")
  const [pending, setPending] = createSignal("")
  const [trees, { refetch }] = createResource(async () => {
    try {
      return (await sdk.client.project.worktrees({ scopeID: props.scopeID }, { throwOnError: true })).data
    } catch (failure) {
      setError(requestErrorMessage(failure, _(copy.unavailable)))
      return []
    }
  })
  async function remove(tree: Worktree) {
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
