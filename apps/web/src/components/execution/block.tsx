import { Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { CopyIconButton } from "@ericsanchezok/synergy-ui/clipboard"
import { E } from "./i18n"

export function EvidenceBlock(props: { label: string; text: string; language?: "json" | "text" }) {
  const { _ } = useLingui()
  return (
    <section class="execution-evidence-block" aria-label={props.label}>
      <header class="execution-evidence-header">
        <h3>{props.label}</h3>
        <span>{props.language === "json" ? "JSON" : "text"}</span>
        <CopyIconButton
          class="execution-icon-button"
          text={() => props.text}
          copyLabel={_({ ...E.copyBlock, values: { label: props.label } })}
          size="small"
        />
      </header>
      <Show when={props.text} fallback={<p class="execution-help">{_(E.noContent)}</p>}>
        <pre class="execution-evidence-text">
          <code>{props.text}</code>
        </pre>
      </Show>
    </section>
  )
}
