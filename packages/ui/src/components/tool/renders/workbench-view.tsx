import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"
import { ToolTextOutput } from "../../tool-output-text"
import { getWorkbenchViewInfo } from "../workbench-info"

ToolRegistry.register({
  name: "workbench_view",
  render(props) {
    const info = getWorkbenchViewInfo(props.input, props.metadata)
    return (
      <BasicTool {...props} trigger={{ ...info, tags: info.args.map((label) => ({ label })) }}>
        <ToolTextOutput text={props.output ?? ""} />
      </BasicTool>
    )
  },
})
