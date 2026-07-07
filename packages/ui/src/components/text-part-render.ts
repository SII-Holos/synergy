export function renderableTextPartMarkdownText(input: { completed: boolean; source: string; typed: string }) {
  return input.completed ? input.source : input.typed
}
