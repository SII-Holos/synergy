import type { PluginComponentProps, PluginWorkbenchSurfaceContext } from "@ericsanchezok/synergy-plugin"
import { Button, Input } from "@ericsanchezok/synergy-plugin/components"
import "./style.css"

export default function Note({ context }: PluginComponentProps<PluginWorkbenchSurfaceContext>) {
  const tab = context.tab
  const text = () => {
    const state = tab().state
    return state && typeof state === "object" && "text" in state && typeof state.text === "string" ? state.text : ""
  }
  context.workbench.beforeClose(
    tab().id,
    () =>
      !tab().dirty ||
      context.overlays.confirm({ title: "Discard note changes?", message: "This note has unsaved edits." }),
  )
  return (
    <section class="example-note" aria-label={tab().title}>
      <Input
        label="Note title"
        value={tab().title ?? ""}
        onChange={(title) => context.workbench.update(tab().id, { title })}
      />
      <Input
        label="Note text"
        multiline
        value={text()}
        onChange={(text) => context.workbench.update(tab().id, { state: { text }, dirty: true })}
      />
      <Button onClick={() => context.workbench.update(tab().id, { dirty: false })}>Save note</Button>
      <Button
        onClick={() => {
          void context.workbench
            .close(tab().id)
            .catch((error) => context.overlays.notify(String(error), { kind: "error" }))
        }}
      >
        Close note
      </Button>
    </section>
  )
}
