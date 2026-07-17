import { type Component, type JSX } from "solid-js"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useLingui } from "@lingui/solid"
import { dialog } from "@/locales/messages"
import { SettingsDialog } from "@/components/settings"
import { QuickSwitcherList } from "@/components/provider/model-manager"
import { ToolbarSelectorPopover } from "@/components/toolbar-selector"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"

export const ModelSelectorPopover: Component<{
  provider?: string
  children: JSX.Element
}> = (props) => {
  const dialogContext = useDialog()
  const { _ } = useLingui()

  return (
    <ToolbarSelectorPopover trigger={props.children} title={_(dialog.selectModel)} contentClass="w-[28rem] h-96">
      {(close) => (
        <div class="flex h-full min-h-0 flex-col p-1">
          <QuickSwitcherList provider={props.provider} onSelect={close} />
          <div class="px-2 pb-2 pt-1 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-12-medium text-text-base"
              onClick={() => {
                close()
                dialogContext.show(() => <SettingsDialog initialTab="models" />)
              }}
            >
              {_(dialog.modelSettings)}
            </Button>
            <Button
              variant="ghost"
              class="h-7 px-2.5 text-12-medium text-text-weak"
              onClick={() => {
                close()
                dialogContext.show(() => <SettingsDialog initialTab="providers" />)
              }}
            >
              {_(dialog.connectProvider)}
            </Button>
          </div>
        </div>
      )}
    </ToolbarSelectorPopover>
  )
}

export const DialogSelectModel: Component<{ provider?: string }> = (props) => {
  const dialogContext = useDialog()
  const { _ } = useLingui()

  return (
    <Dialog
      title={_(dialog.selectModel)}
      description={_(dialog.selectModelDesc)}
      size="list"
      action={
        <Button
          class="h-7 -my-1 text-14-medium"
          icon={getSemanticIcon("settings.models")}
          tabIndex={-1}
          onClick={() => {
            dialogContext.show(() => <SettingsDialog initialTab="models" />)
          }}
        >
          {_(dialog.modelSettings)}
        </Button>
      }
    >
      <div class="flex h-96 min-h-0 flex-col p-1">
        <QuickSwitcherList provider={props.provider} onSelect={() => dialogContext.close()} />
      </div>
    </Dialog>
  )
}
