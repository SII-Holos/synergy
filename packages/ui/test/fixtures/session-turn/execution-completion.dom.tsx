import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider } from "@lingui/solid"
import { ExecutionCompletion, type TurnExecutionSummary } from "../../../src/components/execution-completion"
import { setupI18n } from "../../../src/testing/i18n"

const [summary, setSummary] = createSignal<TurnExecutionSummary>({ status: "running", elapsedMs: 65_000 })
let opened = 0
const dispose = render(
  () => (
    <I18nProvider i18n={setupI18n()}>
      <ExecutionCompletion summary={summary()} onDetails={() => opened++} />
    </I18nProvider>
  ),
  document.getElementById("root")!,
)
Object.assign(globalThis, { executionCompletionFixture: { setSummary, opened: () => opened, dispose } })
