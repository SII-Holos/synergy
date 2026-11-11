import { For, onCleanup, onMount, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import {
  OrganizationSyncProtocol as Sync,
  type OrganizationProtocol as Protocol,
} from "@ericsanchezok/synergy-organization-protocol"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { useSpace } from "@/context/space"
import type { createOrganizationSessionReader } from "./private-read"
import { createOrganizationTaskDirectory } from "./task-directory"
import { WorkspaceError } from "./workspace-error"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import "./tasks.css"

export const organizationTaskMessages = {
  tasks: { id: "organization.tasks.title", message: "Tasks" },
  main: { id: "organization.tasks.main", message: "Main conversation" },
  rootMessage: { id: "organization.tasks.rootMessage", message: "Message to main conversation" },
  first: { id: "organization.tasks.first", message: "First tasks" },
  more: { id: "organization.tasks.more", message: "More tasks" },
  refresh: { id: "organization.tasks.refresh", message: "Refresh tasks" },
  empty: { id: "organization.tasks.empty", message: "No tasks on this page" },
  hint: { id: "organization.tasks.hint", message: "Open a task to read its conversation." },
  queued: { id: "organization.tasks.queued", message: "Queued" },
  running: { id: "organization.tasks.running", message: "Working" },
  completed: { id: "organization.tasks.completed", message: "Completed" },
  error: { id: "organization.tasks.error", message: "Failed" },
  cancelled: { id: "organization.tasks.cancelled", message: "Cancelled" },
  interrupted: { id: "organization.tasks.interrupted", message: "Interrupted" },
}

export function OrganizationTasks(props: {
  sessionID: string
  sourceSessionID?: string
  binding: Protocol.SessionBinding
  read: ReturnType<typeof createOrganizationSessionReader>
  shareGeneration?: number
  open: (task: Sync.TaskSummary) => void
  invalidated: (error: unknown) => void
}) {
  const { _, i18n } = useLingui()
  const space = useSpace()
  const view = space.current()!
  const api = space.client()!
  const directory = createOrganizationTaskDirectory({
    sessionID: props.sessionID,
    sourceSessionID: props.sourceSessionID,
    binding: props.binding,
    read: props.read,
    signal: view.signal,
    invalidated: props.invalidated,
    shared:
      props.shareGeneration !== undefined
        ? {
            generation: props.shareGeneration,
            async load(input, signal) {
              const query = Sync.TaskQuery.parse(input)
              return (
                await api.orgSessionTranscript.tasks(
                  { sessionID: props.sessionID, ...query },
                  { throwOnError: true, signal },
                )
              ).data
            },
          }
        : undefined,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  async function poll() {
    await directory.load(false, true)
    if (!disposed && !view.signal.aborted)
      timer = setTimeout(() => void poll(), document.visibilityState === "visible" ? 5000 : 15000)
  }
  onMount(() => void poll())
  onCleanup(() => {
    disposed = true
    if (timer) clearTimeout(timer)
  })
  return (
    <section class="organization-task-directory" aria-label={_(organizationTaskMessages.tasks)}>
      <div class="organization-page-heading">
        <div>
          <h3>{_(organizationTaskMessages.tasks)}</h3>
          <p>{_(organizationTaskMessages.hint)}</p>
        </div>
        <Button variant="ghost" disabled={directory.loading()} onClick={() => void directory.load()}>
          {_(organizationTaskMessages.refresh)}
        </Button>
      </div>
      <WorkspaceError error={directory.error()} retry={() => void directory.load()} />
      <Show when={directory.loading()}>
        <p role="status">{_(common.loading)}</p>
      </Show>
      <Show when={directory.loaded() && !directory.state.items.length}>
        <p>{_(organizationTaskMessages.empty)}</p>
      </Show>
      <ul class="organization-task-list">
        <For each={directory.state.items}>
          {(task) => (
            <li>
              <button class="organization-publication-entry organization-task-entry" onClick={() => props.open(task)}>
                <span>
                  <strong>{task.description}</strong>
                  <span class="organization-task-metadata">
                    <span>{_(organizationTaskMessages[task.status])}</span>
                    <Show when={task.agent}>
                      <span>{task.agent}</span>
                    </Show>
                    <Show when={task.model}>
                      <span>{task.model!.modelID}</span>
                    </Show>
                    <time dateTime={new Date(task.startedAt).toISOString()}>
                      {new Intl.DateTimeFormat(i18n().locale, { dateStyle: "medium", timeStyle: "short" }).format(
                        task.startedAt,
                      )}
                    </time>
                  </span>
                </span>
              </button>
            </li>
          )}
        </For>
      </ul>
      <div class="organization-actions">
        <Show when={directory.earlier()}>
          <Button disabled={directory.loading()} onClick={() => void directory.load()}>
            {_(organizationTaskMessages.first)}
          </Button>
        </Show>
        <Show when={directory.cursor()}>
          <Button disabled={directory.loading()} onClick={() => void directory.load(true)}>
            {_(organizationTaskMessages.more)}
          </Button>
        </Show>
      </div>
    </section>
  )
}
