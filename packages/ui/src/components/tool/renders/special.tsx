import { Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { DiagramRenderer } from "../../diagram"
import { ToolTextOutput } from "../../tool-output-text"
import { ToolRegistry } from "../../message-part"

ToolRegistry.register({
  name: "diagram",
  render(props) {
    const doc = () => props.metadata?.document as any | undefined
    const stats = () => props.metadata?.stats as Record<string, number> | undefined
    const statsLabel = () => {
      const s = stats()
      if (!s) return ""
      const parts: string[] = []
      if (s.nodes) parts.push(`${s.nodes} nodes`)
      if (s.edges) parts.push(`${s.edges} edges`)
      if (s.items) parts.push(`${s.items} items`)
      if (s.dimensions) parts.push(`${s.dimensions} dims`)
      if (s.steps) parts.push(`${s.steps} steps`)
      if (s.actors) parts.push(`${s.actors} actors`)
      if (s.events) parts.push(`${s.events} events`)
      if (s.depth) parts.push(`depth ${s.depth}`)
      if (s.segments) parts.push(`${s.segments} segments`)
      if (s.series) parts.push(`${s.series} series`)
      if (s.labels) parts.push(`${s.labels} labels`)
      return parts.join(", ")
    }
    return (
      <BasicTool
        {...props}
        defaultOpen
        forceOpen
        trigger={{
          icon: "layout-grid",
          title: "Diagram",
          subtitle: props.input.title || "",
          tags: statsLabel() ? [{ label: statsLabel() }] : undefined,
        }}
      >
        <Show
          keyed
          when={doc()}
          fallback={
            <Show keyed when={props.output}>
              {(output) => (
                <div data-component="tool-output">
                  <ToolTextOutput text={output} />
                </div>
              )}
            </Show>
          }
        >
          {(document) => <DiagramRenderer document={document} />}
        </Show>
      </BasicTool>
    )
  },
})
