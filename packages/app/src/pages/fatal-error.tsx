import { Button } from "@ericsanchezok/synergy-ui/button"
import { Logo } from "@ericsanchezok/synergy-ui/logo"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Component, Show } from "solid-js"
import { useLocale } from "@/context/locale"
import { AP } from "@/app-i18n"
import { usePlatform } from "@/context/platform"
import type { FatalErrorSource } from "./error-presentation"
import { createFatalErrorPresentationMemo } from "./fatal-error-state"

interface FatalErrorPageProps {
  error: unknown
  source?: FatalErrorSource
  onRecover?: () => void
  onSecondaryAction?: () => void
}

export const FatalErrorPage: Component<FatalErrorPageProps> = (props) => {
  const platform = usePlatform()
  const { i18n } = useLocale()

  const presentation = createFatalErrorPresentationMemo({
    source: () => props.source ?? "renderer",
    error: () => props.error,
    onRecover: () => props.onRecover ?? (() => platform.restart()),
    onSecondaryAction: () => props.onSecondaryAction,
  })

  const title = () => i18n._(AP.fatalErrorTitle[presentation().title].id)
  const description = () => i18n._(AP.fatalErrorDescription[presentation().description].id)

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      <div class="w-2/3 max-w-3xl flex flex-col items-center justify-center gap-8">
        <Logo class="w-58.5 opacity-12 shrink-0" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-text-strong">{title()}</h1>
          <p class="text-sm text-text-weak">{description()}</p>
        </div>
        <Show when={presentation().summary}>
          <TextField
            value={presentation().summary}
            readOnly
            multiline
            class="max-h-36 w-full font-mono text-xs no-scrollbar"
            label={i18n._(AP.fatalErrorSummaryLabel.id)}
            hideLabel
          />
        </Show>
        <TextField
          value={presentation().details}
          readOnly
          copyable
          multiline
          class="max-h-96 w-full font-mono text-xs no-scrollbar"
          label={i18n._(AP.errorDetailsLabel.id)}
          hideLabel
        />
        <div class="flex items-center gap-3">
          <Button size="large" onClick={() => presentation().primaryAction.run()}>
            {i18n._(AP.fatalErrorAction[presentation().primaryAction.label].id)}
          </Button>
          <Show when={presentation().secondaryAction}>
            {(action) => (
              <Button size="large" variant="secondary" onClick={() => action().run()}>
                {i18n._(AP.fatalErrorAction[action().label].id)}
              </Button>
            )}
          </Show>
        </div>
        <div class="flex flex-col items-center gap-2">
          <a
            href="https://github.com/SII-Holos/synergy/issues"
            target="_blank"
            rel="noopener noreferrer"
            class="flex items-center justify-center gap-1 text-text-interactive-base hover:underline"
          >
            {i18n._(AP.errorReport.id)}
          </a>
          <Show when={platform.version}>
            <p class="text-xs text-text-weak">{i18n._(AP.errorVersionLabel.id, { version: platform.version })}</p>
          </Show>
        </div>
      </div>
    </div>
  )
}
