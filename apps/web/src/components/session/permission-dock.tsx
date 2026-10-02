import { createMemo, createSignal, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import type { PermissionRequest, ToolPart } from "@ericsanchezok/synergy-sdk/client"
import type { SessionDataView } from "@ericsanchezok/synergy-ui/context/session-data-view"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Popover } from "@ericsanchezok/synergy-ui/popover"
import { ToolRegistry, getToolInfo } from "@ericsanchezok/synergy-ui/message-part"
import { SmartTool } from "@ericsanchezok/synergy-ui/basic-tool"
import { useSessionDataView } from "@/context/session-data-view"
import { useSessionDecision } from "@/context/session-decision"
import { requestSubmissionLocked } from "./request-submission"

const copy = {
  deny: { id: "session.permissionDock.action.deny", message: "Deny" },
  once: { id: "session.permissionDock.action.allowOnce", message: "Allow once" },
  session: { id: "session.permissionDock.action.allowSession", message: "Allow for session" },
  always: { id: "session.permissionDock.action.alwaysAllow", message: "Always allow" },
  more: { id: "session.permissionDock.more", message: "More allow options" },
  sessionScope: {
    id: "session.permissionDock.sessionScope",
    message: "For matching requests in this session; expires when the runtime is recreated or the server restarts",
  },
  persistentScope: {
    id: "session.permissionDock.persistentScope",
    message: "Save this operation and target rules for future matching requests, until you remove the rules",
  },
  details: { id: "session.permissionDock.details", message: "Details" },
  ruleScope: { id: "session.permissionDock.ruleScope", message: "Rule scope" },
  requiresApproval: {
    id: "session.permissionDock.requiresApproval",
    message: "This operation still requires approval each time.",
  },
  submitting: { id: "session.decision.submitting", message: "Submitting…" },
  outsideWorkspace: {
    id: "session.permissionDock.risk.outsideWorkspace",
    message: "Path is outside the workspace boundary",
  },
  vcs: { id: "session.permissionDock.risk.vcsMetadata", message: "Writing to version-control metadata (.git)" },
  credentials: { id: "session.permissionDock.risk.credentials", message: "Accessing credential directory" },
  secrets: { id: "session.permissionDock.risk.secrets", message: "Accessing secrets file (.env / credentials)" },
  destructive: { id: "session.permissionDock.risk.destructiveShell", message: "Destructive shell command" },
  identity: { id: "session.permissionDock.risk.identity", message: "Acting with your identity" },
  email: { id: "session.permissionDock.risk.email", message: "Sending email on your behalf" },
}

export function permissionToolPart(request: PermissionRequest, view: SessionDataView): ToolPart | undefined {
  if (!request.tool) return
  const message = view.messagesFor(request.sessionID).findLast((item) => item.id === request.tool?.messageID)
  if (!message) return
  return view
    .partsFor(message.id)
    .find((part): part is ToolPart => part.type === "tool" && part.callID === request.tool?.callID)
}

export function permissionInfo(request: PermissionRequest, view: SessionDataView) {
  const part = permissionToolPart(request, view)
  return getToolInfo(part?.tool ?? request.permission, part?.state.input ?? {}, request.metadata)
}

export function PermissionDock(props: { request: PermissionRequest }) {
  const view = useSessionDataView()
  const decisions = useSessionDecision()
  const { _ } = useLingui()
  const toolTitle = (title: string | MessageDescriptor) => (typeof title === "string" ? title : _(title))
  const [moreOpen, setMoreOpen] = createSignal(false)
  const [detailsOpen, setDetailsOpen] = createSignal(false)
  const state = () => decisions.state(decisions.key("permission", props.request))
  const locked = () => requestSubmissionLocked(state())
  const part = createMemo(() => permissionToolPart(props.request, view()))
  const info = createMemo(() => permissionInfo(props.request, view()))
  const grantTitle = createMemo(() => getToolInfo(props.request.permission, {}, props.request.metadata).title)
  const command = () => {
    const value = part()?.state.input.command ?? props.request.metadata.command
    return typeof value === "string" ? value : undefined
  }
  const reason = createMemo(() => {
    const meta = props.request.metadata
    const text = meta.reason ?? meta.why
    if (typeof text === "string" && text.trim()) return text
    if (meta.workspaceBoundary || meta.outsideWorkspace) return _(copy.outsideWorkspace)
    if (meta.protectedCategory === "vcs") return _(copy.vcs)
    if (meta.protectedCategory === "credentials") return _(copy.credentials)
    if (meta.protectedCategory === "secrets") return _(copy.secrets)
    if (meta.capability === "shell_destructive") return _(copy.destructive)
    if (meta.capability === "identity_act") return _(copy.identity)
    if (meta.capability === "communication_email") return _(copy.email)
  })
  const respond = (reply: "once" | "session" | "always" | "reject") => {
    setMoreOpen(false)
    void decisions.respondPermission(props.request, reply)
  }

  return (
    <div class="decision-content permission-prompt">
      <div class="decision-body">
        <Show when={command()}>{(value) => <pre class="permission-command">{value()}</pre>}</Show>
        <Show when={props.request.patterns.length > 0}>
          <ul class="permission-targets">
            <For each={props.request.patterns}>{(pattern) => <li>{pattern}</li>}</For>
          </ul>
        </Show>
        <Show when={info().subtitle && !props.request.patterns.length}>
          <p class="decision-secondary">{info().subtitle}</p>
        </Show>
        <Show when={reason()}>{(value) => <p class="permission-reason">{value()}</p>}</Show>
        <details class="permission-details" onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary>{_(copy.details)}</summary>
          <Show when={detailsOpen()}>
            <Show
              when={part()}
              fallback={
                <div class="permission-raw-details">
                  <Show when={command()}>{(value) => <pre>{value()}</pre>}</Show>
                  <ul class="permission-targets">
                    <For each={props.request.patterns}>{(pattern) => <li>{pattern}</li>}</For>
                  </ul>
                  <Show
                    when={Object.keys(props.request.metadata).some(
                      (key) => !["command", "reason", "why"].includes(key),
                    )}
                  >
                    <pre>
                      {JSON.stringify(
                        Object.fromEntries(
                          Object.entries(props.request.metadata).filter(
                            ([key]) => !["command", "reason", "why"].includes(key),
                          ),
                        ),
                        null,
                        2,
                      )}
                    </pre>
                  </Show>
                </div>
              }
            >
              {(current) => (
                <Dynamic
                  component={ToolRegistry.render(current().tool) ?? SmartTool}
                  input={current().state.input}
                  tool={current().tool}
                  metadata={{
                    ...props.request.metadata,
                    ...("metadata" in current().state ? current().state.metadata : undefined),
                  }}
                  output={(() => {
                    const state = current().state
                    return "output" in state ? state.output : undefined
                  })()}
                  status={current().state.status}
                  defaultOpen
                />
              )}
            </Show>
          </Show>
        </details>
      </div>
      <div class="decision-footer">
        <Button variant="ghost" disabled={locked()} onClick={() => respond("reject")}>
          {_(copy.deny)}
        </Button>
        <Popover
          variant="menu"
          title={_(copy.more)}
          open={moreOpen()}
          onOpenChange={setMoreOpen}
          placement="top-end"
          triggerAs={(trigger) => (
            <button {...trigger} type="button" class="decision-secondary-button" disabled={locked()}>
              {_(copy.more)}
            </button>
          )}
        >
          <div class="decision-grant-scope" role="group" aria-label={_(copy.ruleScope)}>
            <p class="decision-secondary">{toolTitle(grantTitle())}</p>
            <ul class="permission-targets">
              <For each={props.request.patterns}>{(pattern) => <li>{pattern}</li>}</For>
            </ul>
            <Show when={props.request.metadata.nonBypassable === true}>
              <p class="decision-secondary">{_(copy.requiresApproval)}</p>
            </Show>
          </div>
          <button type="button" class="decision-menu-row" disabled={locked()} onClick={() => respond("session")}>
            <span>{_(copy.session)}</span>
            <span class="decision-secondary">{_(copy.sessionScope)}</span>
          </button>
          <button type="button" class="decision-menu-row" disabled={locked()} onClick={() => respond("always")}>
            <span>{_(copy.always)}</span>
            <span class="decision-secondary">{_(copy.persistentScope)}</span>
          </button>
        </Popover>
        <Button
          variant="primary"
          disabled={locked()}
          aria-busy={state().status === "pending"}
          onClick={() => respond("once")}
        >
          {_(state().status === "pending" ? copy.submitting : copy.once)}
        </Button>
      </div>
    </div>
  )
}
