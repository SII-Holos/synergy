import { DefaultComposerEditor } from "./default-composer-editor"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import type { PluginComponentProps, PluginInputService } from "@ericsanchezok/synergy-plugin"

export function DefaultComposer(props: PluginComponentProps<{ input: PluginInputService }>) {
  const input = props.context.input
  const report = (error: unknown) =>
    showToast({ type: "error", description: error instanceof Error ? error.message : String(error) })
  return (
    <div class="relative z-0 size-full _max-h-[320px] flex flex-col gap-3 overflow-visible" data-ui-part="composer">
      {input.render("leading")}
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void (input.primaryAction() === "stop" ? input.stop() : input.submit()).catch(report)
        }}
        onDragOver={input.dragOver}
        onDragLeave={input.dragLeave}
        onDrop={(event) => {
          void input.drop(event).catch(report)
        }}
        classList={{
          "prompt-input-shell bg-surface-raised-stronger-non-alpha relative overflow-hidden": true,
          "prompt-input-shell-dragging": input.dragging(),
          "border border-border-base": !input.dragging(),
          "border border-icon-info-active border-dashed": input.dragging(),
          [input.className() ?? ""]: !!input.className(),
        }}
        style={{ "z-index": 1 }}
      >
        {input.render("context")}
        <DefaultComposerEditor context={{ input }} onError={report} />
        {input.render("toolbar")}
      </form>
      {input.render("trailing")}
    </div>
  )
}
