import { useLingui } from "@lingui/solid"
import type { MessageDescriptor } from "@lingui/core"
import { browserErrorPresentation } from "./browser-error"

export function BrowserErrorMessage(props: { error: { code?: string; message: string } }) {
  const { _ } = useLingui()
  const presentation = () => browserErrorPresentation(props.error)
  const translate = (message: MessageDescriptor) => _(message)
  return (
    <div class="min-w-0 flex-1 break-words text-text-weak">
      <span>{translate(presentation())}</span>
      <details class="mt-1 text-12">
        <summary class="cursor-pointer">{_({ id: "browser.failure.details", message: "Diagnostic details" })}</summary>
        <pre class="whitespace-pre-wrap break-words">{presentation().details}</pre>
      </details>
    </div>
  )
}
