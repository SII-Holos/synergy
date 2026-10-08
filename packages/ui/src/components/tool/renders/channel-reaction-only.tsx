import { Show } from "solid-js"
import { BasicTool } from "../../basic-tool"
import { ToolRegistry } from "../../message-part"
import { TOOL_TITLE_DESC } from "../../tool-title-descriptors"

ToolRegistry.register({
  name: "channel_reaction_only",
  render(props) {
    return (
      <BasicTool
        {...props}
        trigger={{
          icon: "message-square-more",
          title: TOOL_TITLE_DESC.channel_reaction_only,
          subtitle: props.input.reaction as string | undefined,
        }}
      >
        <Show when={props.output}>
          {(output) => (
            <div data-component="tool-output" data-scrollable>
              <p data-slot="text">{output()}</p>
            </div>
          )}
        </Show>
      </BasicTool>
    )
  },
})
