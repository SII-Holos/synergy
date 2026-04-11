export function ToolTextOutput(props: { text: string }) {
  return (
    <pre data-component="tool-output-text">
      <code>{props.text}</code>
    </pre>
  )
}
