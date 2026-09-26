import { createEffect, on, onCleanup } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { useGlobalSDK } from "@/context/global-sdk"
import { useLocale } from "@/context/locale"
import { relativeTime } from "@/utils/time"
import { SessionSearchDialog } from "./session-search-dialog"

export function GlobalSearchModal(props: { open: boolean; onClose: () => void }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const { fmt } = useLocale()
  const navigate = useNavigate()
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return
        const id = dialog.push(
          () => (
            <SessionSearchDialog
              fetchPage={async ({ search, includeArchived, offset, limit, signal }) => {
                const response = await globalSDK.client.global.session.search(
                  {
                    search: search || undefined,
                    offset,
                    limit,
                    parentOnly: "false",
                    includeArchived: includeArchived ? "true" : "false",
                  },
                  { signal, throwOnError: true },
                )
                return response.data
              }}
              formatTime={(time) => relativeTime(fmt, time)}
              onSelect={(item) => {
                const scope = item.scope.type === "home" ? "home" : item.scope.id
                navigate(`/${base64Encode(scope)}/session/${item.id}`)
                dialog.close(id)
              }}
              onClose={() => dialog.close(id)}
            />
          ),
          props.onClose,
        )
        onCleanup(() => {
          if (id) dialog.close(id)
        })
      },
    ),
  )
  return null
}
