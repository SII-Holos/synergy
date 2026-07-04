import { createMemo, Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { ANYSEARCH_TOOL_NAMES, getAnysearchToolInfo, type AnysearchToolName } from "../anysearch-info"
import { ToolTextOutput } from "../../tool-output-text"
import { ToolRegistry } from "../../message-part"
import type { ToolProps } from "../../tool-registry-lazy"

function registerAnysearchTool(name: AnysearchToolName) {
  ToolRegistry.register({
    name,
    render(props: ToolProps) {
      const info = createMemo(() => getAnysearchToolInfo(name, props.input ?? {}))
      return (
        <BasicTool
          {...props}
          trigger={{
            icon: info().icon,
            title: info().title,
            subtitle: info().subtitle || "",
            tags: info().args?.map((label) => ({ label })),
          }}
        >
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
}

for (const name of ANYSEARCH_TOOL_NAMES) {
  registerAnysearchTool(name)
}
