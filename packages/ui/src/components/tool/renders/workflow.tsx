import { Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { ToolTextOutput } from "../../tool-output-text"
import { registerTool } from "../../tool-registry-lazy"
import { getWorkflowToolInfo, WORKFLOW_TOOL_NAMES } from "../workflow"

for (const name of WORKFLOW_TOOL_NAMES) {
  registerTool({
    name,
    render(props) {
      const info = getWorkflowToolInfo(name, props.input, props.metadata)
      if (!info) return null
      return (
        <BasicTool
          {...props}
          trigger={{
            icon: info.icon,
            title: info.title,
            subtitle: info.subtitle,
            tags: info.args?.map((label) => ({ label })),
          }}
        >
          <Show keyed when={props.output}>
            {(output) => (
              <div data-component="tool-output" data-scrollable>
                <ToolTextOutput text={output} />
              </div>
            )}
          </Show>
        </BasicTool>
      )
    },
  })
}
