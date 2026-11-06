import { createSignal } from "solid-js"
import type { PluginComponentProps } from "@ericsanchezok/synergy-plugin"
import { Button, Dialog, Input, Popover, Select } from "@ericsanchezok/synergy-plugin/components"
import type { PluginDataContext } from "./generated/plugin-data"
import "./style.css"

export default function Launcher({ context }: PluginComponentProps<PluginDataContext>) {
  const [count, setCount] = createSignal(0)
  context.events.subscribe("changed", (value) => setCount(value.count))
  const report = (error: unknown) => {
    if (context.lifetime.signal.aborted) return
    context.overlays.notify(error instanceof Error ? error.message : String(error), { kind: "error" })
  }
  const settings = async () => {
    const values = await context.settings.get()
    if (context.lifetime.signal.aborted) return
    context.overlays.dialog((handle) => {
      const [name, setName] = createSignal(typeof values.name === "string" ? values.name : "")
      const [mode, setMode] = createSignal("quick")
      return (
        <Dialog title="Example settings">
          <Input label="Display name" value={name()} onChange={setName} />
          <Popover title="Display options" trigger={(props) => <Button {...props}>Options</Button>}>
            <Select
              label="Style"
              value={mode()}
              onChange={setMode}
              options={[
                { value: "quick", label: "Quick" },
                { value: "detailed", label: "Detailed" },
              ]}
            />
          </Popover>
          <Button
            onClick={() => {
              void context.settings
                .replace({ ...values, name: name() })
                .then(() => handle.close())
                .catch(report)
            }}
          >
            Save preferences
          </Button>
        </Dialog>
      )
    })
  }
  return (
    <div class="example-launcher">
      <Button
        onClick={() => {
          void context.workbench.open(`${context.pluginId}:notes`, { id: "first", title: "First note" }).catch(report)
        }}
      >
        Example note
      </Button>
      <Button
        onClick={() => {
          void context.workbench.open(`${context.pluginId}:notes`, { id: "second", title: "Second note" }).catch(report)
        }}
      >
        Second note
      </Button>
      <Button
        onClick={() => {
          void settings().catch(report)
        }}
      >
        Example settings
      </Button>
      <output aria-label="Example counter">{count()}</output>
    </div>
  )
}
