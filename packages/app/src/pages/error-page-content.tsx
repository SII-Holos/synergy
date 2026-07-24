import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Logo } from "@ericsanchezok/synergy-ui/logo"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Show, type Component } from "solid-js"
import { AP } from "@/app-i18n"

export interface ErrorPageContentProps {
  details: string
  version?: string
  onReload: () => void
}

export const ErrorPageContent: Component<ErrorPageContentProps> = (props) => {
  const { _ } = useLingui()

  return (
    <div class="relative flex min-h-screen w-full items-center justify-center bg-background-base px-6 py-12 font-sans">
      <main class="flex w-full max-w-xl flex-col items-center text-center">
        <Logo class="mb-8 w-24 shrink-0 opacity-20" />

        <div class="flex max-w-lg flex-col items-center gap-3">
          <h1 class="text-2xl font-semibold tracking-tight text-text-strong">{_(AP.errorTitle)}</h1>
          <p class="text-base leading-6 text-text-weak">{_(AP.errorSubtitle)}</p>
        </div>

        <div class="mt-7 w-full rounded-xl border border-border-weaker-base bg-surface-raised-base px-5 py-4 text-left">
          <p class="text-sm leading-6 text-text-base">{_(AP.errorTaskSafety)}</p>
        </div>

        <div class="mt-7">
          <Button variant="primary" size="large" onClick={props.onReload}>
            {_(AP.errorReloadInterface)}
          </Button>
        </div>

        <details class="group mt-8 w-full border-t border-border-weaker-base pt-5 text-left">
          <summary class="cursor-pointer select-none text-sm font-medium text-text-weak outline-none transition-colors hover:text-text-base focus-visible:text-text-strong">
            {_(AP.errorTechnicalDetails)}
          </summary>
          <div class="mt-4">
            <TextField
              value={props.details}
              readOnly
              copyable
              multiline
              class="max-h-64 w-full font-mono text-xs no-scrollbar"
              label={_(AP.errorDetailsLabel)}
              hideLabel
            />
          </div>
        </details>

        <footer class="mt-6 flex flex-col items-center gap-2 text-sm">
          <a
            href="https://github.com/SII-Holos/synergy/issues"
            target="_blank"
            rel="noopener noreferrer"
            class="text-text-interactive-base hover:underline focus-visible:underline"
          >
            {_(AP.errorReport)}
          </a>
          <Show when={props.version}>
            {(version) => (
              <p class="text-xs text-text-weak">{_({ ...AP.errorVersionLabel, values: { version: version() } })}</p>
            )}
          </Show>
        </footer>
      </main>
    </div>
  )
}
