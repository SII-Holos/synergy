import { Show, createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip, TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { List } from "@ericsanchezok/synergy-ui/list"
import { DialogSessionExport } from "@/components/dialog/dialog-session-export"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { getAgentVisual, AgentGlyph } from "@/components/agent-visual"
import { ModelSelectorPopover } from "@/components/dialog"
import { useLocal } from "@/context/local"
import { useCommand } from "@/context/command"
import { useSync } from "@/context/sync"
import { titlecaseStatusLabel } from "@ericsanchezok/synergy-ui/session-status"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { isGlobalScope } from "@/utils/scope"
import "./session-top-bar.css"

interface SessionTopBarProps {
  scopeLabel: () => string
  sessionTitle: () => string
}

export function SessionTopBar(props: SessionTopBarProps) {
  const params = useParams()
  const dialog = useDialog()
  const local = useLocal()
  const command = useCommand()
  const sync = useSync()

  const isGlobal = () => (params.dir ? isGlobalScope(base64Decode(params.dir)) : false)

  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
  })

  const currentAgent = createMemo(() => local.agent.current())
  const currentAgentVisual = createMemo(() => getAgentVisual(currentAgent()))

  const isCurrentAgentExternal = createMemo(() => !!currentAgent()?.external)
  const isCurrentExternalModelLocked = createMemo(() => {
    const external = currentAgent()?.external
    if (!external) return false
    if (!sessionHasMessages()) return false
    return external.adapter === "codex"
  })

  return (
    <div class="stb-root">
      <div class="stb-left">
        <Show when={!isGlobal()}>
          <span class="stb-scope">{props.scopeLabel()}</span>
        </Show>
        <span class="stb-title">{props.sessionTitle()}</span>
      </div>
      <div class="stb-right">
        {/* Agent selector */}
        <TooltipKeybind placement="bottom" title="Cycle agent" keybind={command.keybind("agent.cycle")}>
          <ToolbarSelectorPopover
            trigger={
              <button type="button" class="stb-selector-btn">
                <AgentGlyph agent={currentAgent()} size="small" quiet />
                <span class="stb-selector-label">{currentAgentVisual().label}</span>
                <Icon name="chevron-down" size="small" class="stb-chevron" />
              </button>
            }
            title="Select agent"
            contentClass="w-52 max-h-80"
            placement="bottom-end"
          >
            {(close) => (
              <List
                class="p-1"
                items={local.agent.list().filter((a) => !a.hidden)}
                key={(x) => x.name}
                filterKeys={["name"]}
                onSelect={(x) => {
                  if (!x) return
                  if (sessionHasMessages() && x.external) return
                  local.agent.set(x.name)
                  close()
                }}
              >
                {(agent) => {
                  const visual = getAgentVisual(agent)
                  return (
                    <Tooltip
                      placement="right"
                      value={
                        sessionHasMessages() && agent.external
                          ? "Create a new session to use this external agent"
                          : undefined
                      }
                    >
                      <div
                        classList={{
                          "flex items-center justify-between gap-3 px-2 py-1.5": true,
                          "opacity-45": sessionHasMessages() && !!agent.external,
                        }}
                      >
                        <div class="min-w-0">
                          <div class="text-13-medium text-text-base truncate">{visual.label}</div>
                        </div>
                      </div>
                    </Tooltip>
                  )
                }}
              </List>
            )}
          </ToolbarSelectorPopover>
        </TooltipKeybind>

        {/* Model selector */}
        <Show
          when={!isCurrentExternalModelLocked()}
          fallback={
            <Tooltip placement="bottom" value="Model is locked for this external agent after the session starts">
              <button type="button" class="stb-selector-btn stb-locked">
                <span class="stb-selector-label">{local.model.current()?.name ?? "Model locked"}</span>
              </button>
            </Tooltip>
          }
        >
          <ModelSelectorPopover>
            <TooltipKeybind placement="bottom" title="Choose model" keybind={command.keybind("model.choose")}>
              <button type="button" class="stb-selector-btn">
                <span class="stb-selector-label">{local.model.current()?.name ?? "Select model"}</span>
                <Icon name="chevron-down" size="small" class="stb-chevron" />
              </button>
            </TooltipKeybind>
          </ModelSelectorPopover>
        </Show>

        {/* Variant cycle */}
        <Show when={local.model.variant.list().length > 0}>
          <TooltipKeybind placement="bottom" title="Thinking effort" keybind={command.keybind("model.variant.cycle")}>
            <button
              type="button"
              class="stb-selector-btn border-transparent! hover:border-border-weak-base!"
              onClick={() => local.model.variant.cycle()}
            >
              <span class="text-12-regular text-text-weak capitalize">
                {local.model.variant.current() ?? "Default"}
              </span>
            </button>
          </TooltipKeybind>
        </Show>

        <Show when={!!params.id && !isGlobal()}>
          <Tooltip value="Export session data" placement="bottom">
            <button type="button" class="stb-icon-btn" onClick={() => dialog.show(() => <DialogSessionExport />)}>
              <Icon name="download" size="small" />
            </button>
          </Tooltip>
        </Show>
      </div>
    </div>
  )
}
