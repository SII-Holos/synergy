import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { ProviderConnectionFlow } from "@/components/provider/ProviderConnectionFlow"

export function DialogConnectProvider(props: { provider: string }) {
  const dialog = useDialog()

  return (
    <Dialog size="form">
      <div class="pb-1">
        <ProviderConnectionFlow providerID={props.provider} onComplete={() => dialog.close()} />
      </div>
    </Dialog>
  )
}
