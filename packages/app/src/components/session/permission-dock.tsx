import { createMemo, createSignal, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import type { PermissionRequest, ToolPart } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { ToolRegistry, getToolInfo } from "@ericsanchezok/synergy-ui/message-part"
import { SmartTool } from "@ericsanchezok/synergy-ui/basic-tool"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

const copy = {
  agent: { id: "session.permissionDock.agent", message: "Agent" },
  permission: { id: "session.permissionDock.permission", message: "Permission" },
  outsideWorkspace: {
    id: "session.permissionDock.risk.outsideWorkspace",
    message: "Path is outside the workspace boundary",
  },
  vcsMetadata: {
    id: "session.permissionDock.risk.vcsMetadata",
    message: "Writing to version-control metadata (.git)",
  },
  credentials: {
    id: "session.permissionDock.risk.credentials",
    message: "Accessing credential directory",
  },
  secrets: { id: "session.permissionDock.risk.secrets", message: "Accessing secrets file (.env / credentials)" },
  destructiveShell: {
    id: "session.permissionDock.risk.destructiveShell",
    message: "Destructive shell command",
  },
  identity: { id: "session.permissionDock.risk.identity", message: "Acting with your identity" },
  email: { id: "session.permissionDock.risk.email", message: "Sending email on your behalf" },
  fromAgent: { id: "session.permissionDock.origin.from", message: "from" },
  deny: { id: "session.permissionDock.action.deny", message: "Deny" },
  allowSession: { id: "session.permissionDock.action.allowSession", message: "Allow for session" },
  alwaysAllow: { id: "session.permissionDock.action.alwaysAllow", message: "Always allow" },
  allowOnce: { id: "session.permissionDock.action.allowOnce", message: "Allow once" },
}

export interface PermissionDockProps {
  sessionID: string
}

interface PermissionItem {
  permission: PermissionRequest
  origin: "self" | "child"
  sessionTitle?: string
}

export function PermissionDock(props: PermissionDockProps) {
  const data = useData()
  const { _ } = useLingui()
  const toolLabel = (label: string | MessageDescriptor) => (typeof label === "string" ? label : _(label))

  const childSessions = createMemo(() => (data.store.session ?? []).filter((s) => s.parentID === props.sessionID))

  const permissions = createMemo(() => {
    const result: PermissionItem[] = []
    const selfPerms = data.store.permission?.[props.sessionID] ?? []
    for (const perm of selfPerms) {
      result.push({ permission: perm, origin: "self" })
    }
    for (const child of childSessions()) {
      const perms = data.store.permission?.[child.id] ?? []
      for (const perm of perms) {
        result.push({
          permission: perm,
          origin: "child",
          sessionTitle: child.title ?? _(copy.agent),
        })
      }
    }
    return result
  })

  const [activeTab, setActiveTab] = createSignal<string | undefined>(undefined)

  const activeItem = createMemo(() => {
    const all = permissions()
    if (all.length === 0) return undefined
    const tab = activeTab()
    const found = tab ? all.find((p) => p.permission.id === tab) : undefined
    return found ?? all[0]
  })

  const toolPart = createMemo((): ToolPart | undefined => {
    const item = activeItem()
    if (!item?.permission.tool) return undefined
    const { messageID, callID } = item.permission.tool
    const messages = data.store.message[item.permission.sessionID] ?? []
    const message = messages.findLast((m) => m.id === messageID)
    if (!message) return undefined
    const parts = data.store.part[message.id] ?? []
    for (const part of parts) {
      if (part?.type === "tool" && (part as ToolPart).callID === callID) {
        return part as ToolPart
      }
    }
    return undefined
  })

  const permissionLabel = createMemo(() => {
    const item = activeItem()
    if (!item) return _(copy.permission)
    const part = toolPart()
    if (part) {
      const info = getToolInfo(part.tool, part.state?.input, item.permission.metadata)
      const title = toolLabel(info.title)
      if (info.subtitle) return `${title} ${toolLabel(info.subtitle)}`
      return title
    }
    const info = getToolInfo(item.permission.permission, {}, item.permission.metadata ?? {})
    const title = toolLabel(info.title)
    if (info.subtitle) return `${title} ${toolLabel(info.subtitle)}`
    return title
  })

  const respond = (response: "once" | "session" | "always" | "reject") => {
    const item = activeItem()
    if (!item || !data.respondToPermission) return
    data.respondToPermission({
      sessionID: item.permission.sessionID,
      permissionID: item.permission.id,
      response,
    })
  }

  const riskReason = createMemo(() => {
    const item = activeItem()
    if (!item) return undefined
    const meta = item.permission.metadata ?? {}
    const reason = meta.reason ?? meta.why
    if (typeof reason === "string" && reason.trim()) return reason
    if (meta.workspaceBoundary || meta.outsideWorkspace) return _(copy.outsideWorkspace)
    if (meta.protectedCategory === "vcs") return _(copy.vcsMetadata)
    if (meta.protectedCategory === "credentials") return _(copy.credentials)
    if (meta.protectedCategory === "secrets") return _(copy.secrets)
    if (meta.capability === "shell_destructive") return _(copy.destructiveShell)
    if (meta.capability === "identity_act") return _(copy.identity)
    if (meta.capability === "communication_email") return _(copy.email)
    return undefined
  })

  const navigateToChild = () => {
    const item = activeItem()
    if (!item || item.origin !== "child" || !data.navigateToSession) return
    data.navigateToSession(item.permission.sessionID)
  }

  function tabLabel(item: PermissionItem): string {
    const perm = item.permission
    if (!perm.tool) return perm.permission ?? _(copy.permission)
    const { messageID, callID } = perm.tool
    const messages = data.store.message[perm.sessionID] ?? []
    const message = messages.findLast((candidate) => candidate.id === messageID)
    if (message) {
      const parts = data.store.part[message.id] ?? []
      for (const part of parts) {
        if (part?.type === "tool" && (part as ToolPart).callID === callID) {
          const info = getToolInfo((part as ToolPart).tool, (part as ToolPart).state?.input, perm.metadata)
          if (info.subtitle) {
            const subtitle = toolLabel(info.subtitle)
            return subtitle.split("/").pop() ?? subtitle
          }
          return toolLabel(info.title)
        }
      }
    }
    const info = getToolInfo(perm.permission, {}, perm.metadata ?? {})
    if (info.subtitle) {
      const subtitle = toolLabel(info.subtitle)
      return subtitle.split("/").pop() ?? subtitle
    }
    return toolLabel(info.title)
  }

  const multi = createMemo(() => permissions().length > 1)

  return (
    <Show when={permissions().length > 0}>
      <div class="mb-2" style={{ animation: "fadeUp 400ms ease-out" }}>
        <div class="workbench-card-surface rounded-xl border border-border-base overflow-hidden max-h-[min(60vh,480px)] flex flex-col">
          <div class="h-[2px] bg-border-warning-base shrink-0" />

          <Show when={activeItem()}>
            {(item) => (
              <div class="flex flex-col gap-2 px-4 py-3 shrink-0">
                <Show when={multi()}>
                  <Tabs value={activeItem()?.permission.id} onChange={(val) => setActiveTab(val)} variant="pill">
                    <Tabs.List>
                      <For each={permissions()}>
                        {(p) => <Tabs.Trigger value={p.permission.id}>{tabLabel(p)}</Tabs.Trigger>}
                      </For>
                    </Tabs.List>
                  </Tabs>
                </Show>

                <div class="flex items-center justify-between gap-3 overflow-hidden min-w-0">
                  <div class="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
                    <Icon
                      name={getSemanticIcon("settings.permissions")}
                      size="small"
                      class="shrink-0 text-icon-warning-base"
                    />
                    <span class="text-14-medium text-text-strong truncate" title={permissionLabel()}>
                      {permissionLabel()}
                    </span>
                    <Show when={item().origin === "child"}>
                      <span class="text-12-regular text-text-subtle shrink-0">
                        {_(copy.fromAgent)}{" "}
                        <button class="hover:underline cursor-pointer text-text-weak" onClick={navigateToChild}>
                          {item().sessionTitle}
                        </button>
                      </span>
                    </Show>
                  </div>
                  <div class="flex flex-wrap items-center justify-end gap-1.5 shrink-0">
                    <Button variant="ghost" size="small" onClick={() => respond("reject")}>
                      {_(copy.deny)}
                    </Button>
                    <Button variant="ghost" size="small" onClick={() => respond("session")}>
                      {_(copy.allowSession)}
                    </Button>
                    <Button variant="ghost" size="small" onClick={() => respond("always")}>
                      {_(copy.alwaysAllow)}
                    </Button>
                    <Button variant="primary" size="small" onClick={() => respond("once")}>
                      {_(copy.allowOnce)}
                    </Button>
                  </div>
                </div>
                <Show when={riskReason()}>
                  {(reason) => (
                    <div class="flex items-center gap-1.5 text-12-regular text-text-weak">
                      <Icon name={getSemanticIcon("state.warning")} size="small" class="shrink-0 text-icon-weak-base" />
                      <span>{reason()}</span>
                    </div>
                  )}
                </Show>
              </div>
            )}
          </Show>

          {(() => {
            const item = activeItem()
            if (!item?.permission.tool) return null
            const part = toolPart()
            const toolName = part?.tool ?? item.permission.permission
            const render = ToolRegistry.render(toolName) ?? SmartTool
            const state = part?.state
            const input = state?.input ?? {}
            const permissionMetadata = item.permission.metadata ?? {}
            const stateMetadata = state && "metadata" in state ? (state.metadata ?? {}) : {}
            const metadata = { ...permissionMetadata, ...stateMetadata }
            const output = state && "output" in state ? state.output : undefined
            const status = state?.status ?? "running"
            return (
              <div class="border-t border-border-base px-4 py-3 overflow-y-auto min-h-0 [scrollbar-width:thin]">
                <Dynamic
                  component={render}
                  input={input}
                  tool={toolName}
                  metadata={metadata}
                  output={output}
                  status={status}
                  defaultOpen={true}
                />
              </div>
            )
          })()}
        </div>
      </div>
    </Show>
  )
}
