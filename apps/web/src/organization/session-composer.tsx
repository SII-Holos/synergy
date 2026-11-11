import { createSignal, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { MenuField } from "@ericsanchezok/synergy-ui/menu-field"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import type {
  OrgSessionDirectoryView,
  OrgCommandControl,
  OrgCommandView,
} from "@ericsanchezok/synergy-sdk/organization"
import { generateSecureUUID } from "@ericsanchezok/synergy-util/uuid"
import { OrganizationCommandProtocol as Command } from "@ericsanchezok/synergy-organization-protocol"
import { useSpace } from "@/context/space"
import { useConfirm } from "@/components/dialog/confirm-dialog"
import { Persist, persisted } from "@/utils/persist"
import { createOrganizationCommandState, type OrganizationPendingCommand } from "./command-state"
import { WorkspaceError } from "./workspace-error"
import { organizationSessionMessages as messages } from "./session-messages"
import { organizationWorkspaceMessages as common } from "./workspace-messages"
import { organizationCommandAccepted, OrganizationCommandReceiptError } from "./command-receipt"

export function OrganizationSessionComposer(props: {
  session: OrgSessionDirectoryView
  online: boolean
  modelReady: boolean
  messageLabel?: string
  control?: { controlVersion: number; pausedSince?: number; runID?: string }
  accepted: () => void
}) {
  const { _ } = useLingui()
  const space = useSpace()
  const api = space.client()!
  const view = space.current()!
  const confirm = useConfirm()
  const options = { throwOnError: true, signal: view.signal } as const
  const owner = `project:${props.session.projectID}:session:${props.session.sessionID}`
  const [draft, setDraft] = persisted(
    Persist.connection(view.key, `${owner}:composer`),
    createStore({ text: "", mode: "task" as "task" | "steer" | "context" }),
  )
  const outbox = createOrganizationCommandState(localStorage, view.key, owner)
  const [pending, setPending] = createSignal<OrganizationPendingCommand>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<unknown>()
  const [notice, setNotice] = createSignal(false)
  const [canRetry, setCanRetry] = createSignal(false)
  const [blocked, setBlocked] = createSignal(false)
  try {
    setPending(outbox.pending())
  } catch (error) {
    setError(error)
    setBlocked(true)
  }
  const input = () => ({
    operation: "input" as const,
    mode: draft.mode,
    parts: [{ type: "text" as const, text: draft.text }],
  })
  const tooLarge = () => !Command.Input.safeParse(input()).success
  const envelope = () => ({
    schemaVersion: 1 as const,
    orgID: space.connection()!.orgID,
    requestID: generateSecureUUID(),
    sessionID: props.session.sessionID,
    projectID: props.session.projectID,
    runtimeID: props.session.driverRuntimeID,
  })
  function complete(request: OrganizationPendingCommand) {
    outbox.clear(request.requestID)
    setPending(undefined)
    setCanRetry(false)
    setNotice(true)
    if (
      "input" in request &&
      request.input.mode === draft.mode &&
      request.input.parts.map((part) => part.text).join("") === draft.text
    )
      setDraft("text", "")
    props.accepted()
  }
  async function submit(request: OrganizationPendingCommand) {
    if (busy() || blocked() || !props.online) return
    setBusy(true)
    setError(undefined)
    setNotice(false)
    setCanRetry(false)
    try {
      const saved = outbox.begin(request)
      if ("creation" in saved) throw new Error("A different operation is awaiting its receipt")
      setPending(saved)
      const result =
        "input" in saved
          ? await api.orgCommands.input({ sessionID: saved.sessionID, orgCommandInputRequest: saved }, options)
          : await api.orgCommands.control({ sessionID: saved.sessionID, orgCommandControlRequest: saved }, options)
      organizationCommandAccepted(saved, result.data, space.connection()!.account.accountID)
      if (!view.signal.aborted) complete(saved)
    } catch (error) {
      if (!view.signal.aborted) {
        setError(error)
        if (error && typeof error === "object" && "outcome" in error && error.outcome === "not_dispatched")
          setCanRetry(true)
      }
    } finally {
      if (!view.signal.aborted) setBusy(false)
    }
  }
  async function check() {
    const request = pending()
    if (!request || busy() || !("sessionID" in request)) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await api.orgCommands.lookup({ requestID: request.requestID }, options)
      if (view.signal.aborted) return
      receive(result.data, request)
    } catch (error) {
      if (!view.signal.aborted) setError(error)
    } finally {
      if (!view.signal.aborted) setBusy(false)
    }
  }
  function receive(receipt: OrgCommandView, request: OrganizationPendingCommand) {
    if (receipt.requestID !== request.requestID) throw new OrganizationCommandReceiptError()
    const accepted = receipt.accepted ?? receipt.result?.accepted
    if (accepted) {
      organizationCommandAccepted(request, accepted, space.connection()!.account.accountID)
      complete(request)
      return
    }
    if (receipt.state === "not_dispatched") setCanRetry(true)
    if (receipt.state === "rejected") {
      outbox.clear(request.requestID)
      setPending(undefined)
      setError({ code: "COMMAND_REJECTED" })
    }
  }
  function control(value: OrgCommandControl) {
    if (!pending() && props.online) void submit({ ...envelope(), control: value })
  }
  return (
    <form
      class="organization-session-composer"
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending() && props.session.permissions.execute && props.modelReady && !tooLarge() && draft.text.trim())
          void submit({
            ...envelope(),
            input: input(),
          })
      }}
    >
      <WorkspaceError error={error()} />
      <Show when={!props.online}>
        <p role="status">{_(common.offline)}</p>
      </Show>
      <Show when={notice()}>
        <p role="status">{_(messages.accepted)}</p>
      </Show>
      <Show when={pending()}>
        <p role="status">{_(messages.pending)}</p>
        <div class="organization-actions">
          <Button type="button" disabled={busy()} onClick={() => void check()}>
            {_(messages.checkStatus)}
          </Button>
          <Show when={canRetry()}>
            <Button
              type="button"
              disabled={busy() || !props.online}
              onClick={() => {
                const request = pending()
                if (request) void submit(request)
              }}
            >
              {_(common.retry)}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={props.session.permissions.execute}>
        <TextField
          label={props.messageLabel ?? _(messages.message)}
          placeholder={_({ id: "organization.session.messagePlaceholder", message: "Write a message…" })}
          multiline
          value={draft.text}
          onChange={(text) => setDraft("text", text)}
          description={_(messages.draftHint)}
        />
        <Show when={tooLarge()}>
          <p role="alert">
            {_({
              id: "organization.session.messageTooLarge",
              message: "This message exceeds the supported input size. Your draft is retained; send a smaller message.",
            })}
          </p>
        </Show>
      </Show>
      <div class="organization-actions">
        <Show when={props.session.permissions.execute}>
          <MenuField
            ariaLabel={_(messages.inputMode)}
            value={draft.mode}
            onChange={(mode) => setDraft("mode", mode)}
            options={(["task", "steer", "context"] as const).map((value) => ({ value, label: _(messages[value]) }))}
          />
          <Button
            size="large"
            variant="primary"
            type="submit"
            disabled={
              !props.online ||
              !props.modelReady ||
              busy() ||
              blocked() ||
              !!pending() ||
              !draft.text.trim() ||
              tooLarge()
            }
          >
            {_(messages.send)}
          </Button>
        </Show>
        <Show when={props.session.permissions.stop}>
          <Button
            type="button"
            disabled={!props.online || busy() || !!pending()}
            onClick={() => control({ operation: "pause" })}
          >
            {_(messages.pause)}
          </Button>
        </Show>
        <Show when={props.session.permissions.execute && props.control?.pausedSince !== undefined}>
          <Button
            type="button"
            disabled={!props.online || busy() || !!pending()}
            onClick={() => {
              const observed = props.control
              if (observed?.pausedSince !== undefined)
                control({
                  operation: "continue",
                  pausedSince: observed.pausedSince,
                  controlVersion: observed.controlVersion,
                })
            }}
          >
            {_(messages.continue)}
          </Button>
        </Show>
        <Show when={props.session.permissions.stop && props.control?.runID}>
          <Button
            class="organization-session-cancel"
            aria-label={_(messages.cancel)}
            title={_(messages.cancel)}
            type="button"
            disabled={!props.online || busy() || !!pending()}
            onClick={() => {
              const observed = props.control
              if (!observed?.runID) return
              confirm.show({
                title: messages.cancel,
                description: messages.cancelHint,
                confirmLabel: messages.cancel,
                tone: "warning",
                onConfirm: () =>
                  control({ operation: "cancel", runID: observed.runID!, controlVersion: observed.controlVersion }),
              })
            }}
          >
            <Icon class="organization-session-cancel-icon" name={getSemanticIcon("action.stop")} size="small" />
            <span class="organization-session-cancel-label">{_(messages.cancel)}</span>
          </Button>
        </Show>
      </div>
    </form>
  )
}
