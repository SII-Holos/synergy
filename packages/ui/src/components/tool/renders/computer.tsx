import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"
import { getComputerToolPresentation } from "../classifier"
import { RawOutput } from "../body-primitives"

for (const name of ["computer_apps", "computer_observe", "computer_action"] as const) {
  ToolRegistry.register({
    name,
    render(props) {
      return (
        <BasicTool {...props} trigger={getComputerToolPresentation(name, props.input)!}>
          <RawOutput output={props.output} />
        </BasicTool>
      )
    },
  })
}
