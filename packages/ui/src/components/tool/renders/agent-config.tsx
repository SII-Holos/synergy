import { useLingui } from "@lingui/solid"
import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../tool-registry-lazy"
import { TOOL_TITLE_DESC, TOOL_LABEL_DESC } from "../../tool-title-descriptors"

ToolRegistry.register({
  name: "agent_config",
  render(props) {
    const { _ } = useLingui()
    const count = props.metadata?.count
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "bot",
          title: TOOL_TITLE_DESC["agent_config"],
          subtitle: props.input?.input?.name ?? "",
          tags:
            typeof count === "number" ? [{ label: _({ ...TOOL_LABEL_DESC.agents, values: { count } }) }] : undefined,
        }}
      />
    )
  },
})
