import { Show, createMemo } from "solid-js"
import { useParams } from "@solidjs/router"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { Tooltip, TooltipKeybind } from "@ericsanchezok/synergy-ui/tooltip"
import { DialogSessionExport } from "@/components/dialog/dialog-session-export"
import { ModelSelectorPopover } from "@/components/dialog"
import { useLocal } from "@/context/local"
import { useCommand } from "@/context/command"
import { useSync } from "@/context/sync"
import { base64Decode } from "@ericsanchezok/synergy-util/encode"
import { isHomeScope } from "@/utils/scope"
import { useSessionMeta } from "@/composables/use-session-meta"
import "./session-top-bar.css"

export function SessionTopBar() {
  const params = useParams()
  const dialog = useDialog()
  const local = useLocal()
  const command = useCommand()
  const sync = useSync()

  const isGlobal = () => (params.dir ? isHomeScope(base64Decode(params.dir)) : false)

  const sessionInfo = createMemo(() => (params.id ? sync.session.get(params.id) : undefined))

  const sessionHasMessages = createMemo(() => {
    if (!params.id) return false
    return (sync.data.message[params.id] ?? []).length > 0
  })

  const sessionMeta = useSessionMeta(sessionInfo, sessionHasMessages)

  const isCurrentAgentExternal = createMemo(() => !!local.agent.current()?.external)
  const isCurrentExternalModelLocked = createMemo(() => {
    const external = local.agent.current()?.external
    if (!external) return false
    if (!sessionHasMessages()) return false
    return external.adapter === "codex"
  })

  return (
    <div class="stb-root">
      <div class="stb-left">
        <Show when={!isGlobal()}>
          <Icon name="folder" size="normal" class="stb-folder" />
          <span class="stb-slash">/</span>
        </Show>
        {/* Model selector */}
        <Show when={sessionMeta().canSelectModel}>
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
                  <Icon name="chevron-down" size="normal" class="stb-chevron" />
                </button>
              </TooltipKeybind>
            </ModelSelectorPopover>
          </Show>
        </Show>

        {/* Variant cycle */}
        <Show when={local.model.variant.list().length > 0}>
          <TooltipKeybind placement="bottom" title="Thinking effort" keybind={command.keybind("model.variant.cycle")}>
            <button
              type="button"
              class="stb-selector-btn border-transparent! hover:border-border-weak-base!"
              onClick={() => local.model.variant.cycle()}
            >
              <span class="stb-variant-label">{local.model.variant.current() ?? "Default"}</span>
            </button>
          </TooltipKeybind>
        </Show>
      </div>
      <div class="stb-right">
        <Show when={!!params.id && !isGlobal()}>
          <Tooltip value="Export session data" placement="bottom">
            <button type="button" class="stb-icon-btn" onClick={() => dialog.show(() => <DialogSessionExport />)}>
              <Icon name="download" size="normal" />
            </button>
          </Tooltip>
        </Show>
      </div>
    </div>
  )
}
