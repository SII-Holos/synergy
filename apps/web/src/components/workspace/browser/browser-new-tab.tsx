import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { browser as B } from "@/locales/messages"

export function BrowserNewTab(props: { pending?: boolean; onNavigate: (url: string) => void; onImport: () => void }) {
  const { _ } = useLingui()
  return (
    <div class="browser-new-tab">
      <div class="browser-new-tab-center">
        <div class="browser-new-tab-search">
          <Icon name={getSemanticIcon("action.search")} size="small" />
          <input
            disabled={props.pending}
            aria-label={_(B.enterUrl)}
            placeholder={_(B.enterUrl)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.isComposing || !event.currentTarget.value.trim()) return
              event.preventDefault()
              props.onNavigate(event.currentTarget.value.trim())
            }}
          />
        </div>
      </div>
      <div class="browser-new-tab-footer">
        <Button class="browser-import-entry" size="small" variant="ghost" onClick={() => props.onImport()}>
          <Icon name={getSemanticIcon("action.import")} size="small" />
          {_(B.importData)}
        </Button>
      </div>
    </div>
  )
}
