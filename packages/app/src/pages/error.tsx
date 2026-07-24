import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { Logo } from "@ericsanchezok/synergy-ui/logo"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Component, Show } from "solid-js"
import { useLocale } from "@/context/locale"
import { AP } from "@/app-i18n"
import { usePlatform } from "@/context/platform"
import { formatError } from "./error-format"
export type { InitError } from "./error-format"

interface ErrorPageProps {
  error: unknown
}

export const ErrorPage: Component<ErrorPageProps> = (props) => {
  const platform = usePlatform()
  const { i18n } = useLocale()

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      <div class="w-2/3 max-w-3xl flex flex-col items-center justify-center gap-8">
        <Logo class="w-58.5 opacity-12 shrink-0" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-text-strong">{i18n._(AP.errorTitle.id)}</h1>
          <p class="text-sm text-text-weak">{i18n._(AP.errorSubtitle.id)}</p>
        </div>
        <TextField
          value={formatError(props.error)}
          readOnly
          copyable
          multiline
          class="max-h-96 w-full font-mono text-xs no-scrollbar"
          label={i18n._(AP.errorDetailsLabel.id)}
          hideLabel
        />
        <div class="flex items-center gap-3">
          <Button size="large" onClick={platform.restart}>
            {i18n._(AP.errorRestart.id)}
          </Button>
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
