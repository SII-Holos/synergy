import { useLingui } from "@lingui/solid"
import { BasicTool } from "./basic-tool"
import { ToolRegistry } from "./message-part"
import { getLatticeToolPresentation } from "./tool/classifier"

const PATHWAY_STEPS_DESCRIPTOR = { id: "tool.label.pathwaySteps", message: "{count} steps" }

for (const name of ["pathway_read", "pathway_write", "lattice_submit"] as const) {
  ToolRegistry.register({
    name,
    render(props) {
      const { _ } = useLingui()
      const info = getLatticeToolPresentation(name, props.input, props.metadata)
      if (!info) return null

      let tags = info.args?.map((label) => ({ label }))
      if (name === "pathway_write" && Array.isArray(props.input?.steps)) {
        tags = [
          {
            label: _({
              ...PATHWAY_STEPS_DESCRIPTOR,
              values: { count: props.input.steps.length },
            }),
          },
        ]
      }
      if (name === "lattice_submit") {
        const source = typeof props.metadata?.source === "string" ? props.metadata.source : "tool"
        tags = [
          {
            label:
              source === "panel"
                ? _({ id: "tool.label.latticeSourcePanel", message: "Panel" })
                : _({ id: "tool.label.latticeSourceChat", message: "Chat" }),
          },
        ]
      }

      return (
        <BasicTool
          {...props}
          trigger={{
            icon: info.icon,
            title: info.title,
            subtitle: info.subtitle,
            tags,
          }}
        />
      )
    },
  })
}

export * from "./tool/renders/file-ops"
export * from "./tool/renders/standard"
export * from "./tool/renders/task"
export * from "./tool/renders/dag"
export * from "./tool/renders/special"
export * from "./tool/renders/browser"
export * from "./tool/renders/anysearch"
export * from "./tool/renders/batch"
