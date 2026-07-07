import { type Component, type JSX } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { SettingsDialog } from "@/components/settings"
import { QuickSwitcherList } from "@/components/model-manager"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export const ModelSelectorPopover: Component<{
  provider?: string
  children: JSX.Element
}> = (props) => {
  const dialog = useDialog()

  return (
    <ToolbarSelectorPopover trigger={props.children} title="Select model" contentClass="w-[28rem] h-96">
      {(close) => (
        <div class="flex h-full min-h-0 flex-col p-1">
          <QuickSwitcherList provider={props.provider} onSelect={close} />
          <div class="px-2 pb-2 pt-1 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-12-medium text-text-base"
              onClick={() => {
                close()
                dialog.show(() => <SettingsDialog initialTab="models" />)
              }}
            >
              Model settings
            </Button>
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-12-medium text-text-weak"
              onClick={() => {
                close()
                dialog.show(() => <SettingsDialog initialTab="providers" />)
              }}
            >
              Connect provider
            </Button>
          </div>
        </div>
      )}
    </ToolbarSelectorPopover>
  )
}

export const DialogSelectModel: Component<{ provider?: string }> = (props) => {
  const dialog = useDialog()

  return (
    <Dialog
      title="Select model"
      description="Choose a quick-switch model for the current session."
      size="list"
      action={
        <Button
          class="h-7 -my-1 text-14-medium"
          icon={getSemanticIcon("settings.models")}
          tabIndex={-1}
          onClick={() => {
            dialog.show(() => <SettingsDialog initialTab="models" />)
          }}
        >
          Model settings
        </Button>
      }
    >
      <div class="flex h-96 min-h-0 flex-col p-1">
        <QuickSwitcherList provider={props.provider} onSelect={() => dialog.close()} />
      </div>
    </Dialog>
  )
}
