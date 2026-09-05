import { useLingui } from "@lingui/solid"
import { BasicTool } from "./basic-tool"
import { ToolRegistry } from "./message-part"
import { getLatticeToolPresentation } from "./tool/classifier"
import { getSemanticIcon } from "./semantic-icon"
import { TOOL_TITLE_DESC } from "./tool-title-descriptors"

const PATHWAY_STEPS_DESCRIPTOR = { id: "tool.label.pathwaySteps", message: "{count} steps" }

for (const name of ["pathway_read", "pathway_write", "lattice_submit"] as const) {
  ToolRegistry.register({
    name,
    render(props) {
      const { _ } = useLingui()
      const info = getLatticeToolPresentation(name, props.input, props.metadata)
      if (!info) return null

      let tags = info.args?.map((label) => ({ label }))
      const pathwaySteps =
        name === "pathway_write"
          ? Array.isArray(props.input?.futureSteps)
            ? props.input.futureSteps
            : Array.isArray(props.input?.steps)
              ? props.input.steps
              : undefined
          : undefined
      if (pathwaySteps) {
        tags = [
          {
            label: _({
              ...PATHWAY_STEPS_DESCRIPTOR,
              values: { count: pathwaySteps.length },
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

for (const name of [
  "boss_spawn",
  "boss_assign",
  "boss_report",
  "boss_status",
  "boss_cancel",
  "boss_project",
  "channel_push",
] as const) {
  ToolRegistry.register({
    name,
    render(props) {
      return (
        <BasicTool
          {...props}
          trigger={{
            icon: getSemanticIcon("prompt.boss"),
            title: TOOL_TITLE_DESC[name],
            subtitle:
              props.input.role ||
              props.input.sessionID ||
              props.input.taskID ||
              props.input.status ||
              props.input.directory ||
              props.input.title ||
              props.input.text ||
              props.input.chatId ||
              "",
            tags:
              name === "boss_status" && props.metadata?.workerCount !== undefined
                ? [{ label: String(props.metadata.workerCount) }]
                : undefined,
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
export * from "./tool/renders/browser"
export * from "./tool/renders/anysearch"
export * from "./tool/renders/scholight"
export * from "./tool/renders/batch"
