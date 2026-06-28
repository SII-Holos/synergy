import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"

export function DialogConnectProvider(props: { provider: string }) {
  const dialog = useDialog()

  return (
    <Dialog>
      <div class="px-2.5 pb-3 min-w-[420px]">
        <ProviderConnectionFlow providerID={props.provider} onComplete={() => dialog.close()} />
      </div>
    </Dialog>
  )
}
