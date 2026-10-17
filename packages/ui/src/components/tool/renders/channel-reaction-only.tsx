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
          // The tool records its terminal intent in part metadata; input is
          // always an empty object because the tool takes no parameters.
          subtitle: (props.metadata?.intent as { reaction?: string } | undefined)?.reaction,
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
