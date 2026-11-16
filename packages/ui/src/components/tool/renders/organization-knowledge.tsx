import { Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"
import { ToolTextOutput } from "../../tool-output-text"
import { getOrganizationKnowledgeInfo } from "../organization-knowledge-info"

ToolRegistry.register({
  name: "organization_knowledge",
  render(props) {
    return (
      <BasicTool {...props} trigger={getOrganizationKnowledgeInfo(props.input, props.metadata)}>
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <ToolTextOutput text={output()} />
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})
