import { Show } from "solid-js"

interface Props {
  action: string | null
}

/**
 * Shows a subtle indicator when the Synergy agent is actively using the browser.
 * Displays the current action (e.g., "Clicked button 'Submit'") as a toast-style bar.
 */
export function AgentAssistant(props: Props) {
  return (
    <Show when={props.action}>
      <div class="absolute top-2 right-2 z-40 px-3 py-1.5 rounded-full bg-accent/20 border border-accent/30 text-xs text-accent flex items-center gap-2 animate-pulse">
        <span class="inline-block w-2 h-2 rounded-full bg-accent" />
        <span>Agent: {props.action}</span>
      </div>
    </Show>
  )
}
