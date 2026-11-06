import type { PluginComponentProps, PluginTextActionSurfaceContext } from "@ericsanchezok/synergy-plugin"
export default function Selection({ context }: PluginComponentProps<PluginTextActionSurfaceContext>) {
  const result = context.textAction.output
  return (
    <output aria-label="Uppercase result">
      {result && typeof result === "object" && "text" in result && typeof result.text === "string" ? result.text : ""}
    </output>
  )
}
