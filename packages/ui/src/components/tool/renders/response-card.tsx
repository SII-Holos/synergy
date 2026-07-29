import { useLingui } from "@lingui/solid"
import { Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"
import { TOOL_LABEL_DESC, TOOL_TITLE_DESC } from "../../tool-title-descriptors"
import { ToolTextOutput } from "../../tool-output-text"

ToolRegistry.register({
  name: "response_card",
  render(props) {
    const { _ } = useLingui()
    const elements = () => (Array.isArray(props.input.elements) ? props.input.elements : [])
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "message-square-more",
          title: TOOL_TITLE_DESC.response_card,
          subtitle: props.input.title as string | undefined,
          tags: elements().length
            ? [{ label: _({ ...TOOL_LABEL_DESC.elements, values: { count: elements().length } }) }]
            : undefined,
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
