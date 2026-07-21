import { Show } from "solid-js"
import { browserToolLabels, ToolRegistry } from "../../message-part"
import { BasicTool } from "../../basic-tool"
import { ToolTextOutput } from "../../tool-output-text"

function subtitle(input: Record<string, any>, metadata: Record<string, any> | undefined): string | undefined {
  return metadata?.url ?? input.url ?? input.action ?? input.type
}

function tags(metadata: Record<string, any> | undefined) {
  const values = [
    metadata?.entryCount != null ? `${metadata.entryCount} console` : undefined,
    metadata?.requestCount != null ? `${metadata.requestCount} requests` : undefined,
    metadata?.assetCount != null ? `${metadata.assetCount} assets` : undefined,
    metadata?.elementsCount != null ? `${metadata.elementsCount} elements` : undefined,
    metadata?.captureKind,
  ].filter(Boolean) as string[]
  return values.map((label) => ({ label }))
}

for (const [name, config] of Object.entries(browserToolLabels)) {
  ToolRegistry.register({
    name,
    render(props) {
      return (
        <BasicTool
          {...props}
          trigger={{
            icon: config.icon,
            title: config.title,
            subtitle: subtitle(props.input, props.metadata),
            tags: tags(props.metadata),
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
