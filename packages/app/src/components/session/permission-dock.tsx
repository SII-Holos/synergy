import { createMemo, createSignal, For, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { PermissionRequest, ToolPart } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tabs } from "@ericsanchezok/synergy-ui/tabs"
import { useData } from "@ericsanchezok/synergy-ui/context"
import { ToolRegistry, getToolInfo } from "@ericsanchezok/synergy-ui/message-part"
import { GenericTool } from "@ericsanchezok/synergy-ui/basic-tool"

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
          sessionTitle: child.title ?? "Agent",
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
    if (!item || !item.permission.tool) return undefined
    const messages = data.store.message[item.permission.sessionID] ?? []
    const message = messages.findLast((m) => m.id === item.permission.tool!.messageID)
    if (!message) return undefined
    const parts = data.store.part[message.id] ?? []
    for (const part of parts) {
      if (part?.type === "tool" && (part as ToolPart).callID === item.permission.tool!.callID) {
        return part as ToolPart
      }
    }
    return undefined
  })

  const permissionLabel = createMemo(() => {
    const part = toolPart()
    const item = activeItem()
    if (!part) return item?.permission.permission ?? "Permission"
    const info = getToolInfo(part.tool, part.state?.input)
    if (info.subtitle) return `${info.title} ${info.subtitle}`
    return info.title
  })

  const respond = (response: "once" | "reject") => {
    const item = activeItem()
    if (!item || !data.respondToPermission) return
    data.respondToPermission({
      sessionID: item.permission.sessionID,
      permissionID: item.permission.id,
      response,
    })
  }

  const navigateToChild = () => {
    const item = activeItem()
    if (!item || item.origin !== "child" || !data.navigateToSession) return
    data.navigateToSession(item.permission.sessionID)
  }

  function tabLabel(item: PermissionItem): string {
    const perm = item.permission
    if (perm.tool) {
      const messages = data.store.message[perm.sessionID] ?? []
      const message = messages.findLast((m) => m.id === perm.tool!.messageID)
      if (message) {
        const parts = data.store.part[message.id] ?? []
        for (const part of parts) {
          if (part?.type === "tool" && (part as ToolPart).callID === perm.tool!.callID) {
            const info = getToolInfo((part as ToolPart).tool, (part as ToolPart).state?.input)
            if (info.subtitle) return info.subtitle.split("/").pop() ?? info.subtitle
            return info.title
          }
        }
      }
    }
    return perm.permission ?? "Permission"
  }

  const multi = createMemo(() => permissions().length > 1)

  return (
    <Show when={permissions().length > 0}>
      <div class="mb-2" style={{ animation: "fadeUp 400ms ease-out" }}>
        <div class="rounded-xl bg-surface-raised-stronger-non-alpha border border-border-base overflow-hidden max-h-[min(60vh,480px)] flex flex-col">
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

                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 min-w-0 flex-1">
                    <Icon name="shield-alert" size="small" class="shrink-0 text-icon-warning-base" />
                    <span class="text-14-medium text-text-strong truncate">{permissionLabel()}</span>
                    <Show when={item().origin === "child"}>
                      <span class="text-12-regular text-text-subtle shrink-0">
                        from{" "}
                        <button class="hover:underline cursor-pointer text-text-weak" onClick={navigateToChild}>
                          {item().sessionTitle}
                        </button>
                      </span>
                    </Show>
                  </div>
                  <div class="flex items-center gap-1.5 shrink-0">
                    <Button variant="ghost" size="small" onClick={() => respond("reject")}>
                      Deny
                    </Button>
                    <Button variant="primary" size="small" onClick={() => respond("once")}>
                      Allow once
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </Show>

          <Show when={toolPart()}>
            {(part) => (
              <div class="border-t border-border-base px-4 py-3 overflow-y-auto min-h-0 [scrollbar-width:thin]">
                {(() => {
                  const p = part()
                  const render = ToolRegistry.render(p.tool) ?? GenericTool
                  const input = p.state?.input ?? {}
                  // @ts-expect-error - metadata/output not present on all ToolState variants
                  const metadata = p.state?.metadata ?? {}
                  return (
                    <Dynamic
                      component={render}
                      input={input}
                      tool={p.tool}
                      metadata={metadata}
                      // @ts-expect-error - output not present on all ToolState variants
                      output={p.state.output}
                      status={p.state.status}
                      defaultOpen={true}
                    />
                  )
                })()}
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  )
}
