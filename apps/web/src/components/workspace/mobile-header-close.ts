import { useNavigate } from "@solidjs/router"
import { useParams } from "@/context/session-route"
import { useLayout } from "@/context/layout"

export function useWorkspaceMobileHeaderClose() {
  const navigate = useNavigate()
  const layout = useLayout()
  const params = useParams()

  return () => {
    if (params.dir && params.id) {
      const sessionKey = `${params.dir}/${params.id}`
      layout.surface(sessionKey, "side").close()
    } else {
      navigate(-1)
    }
  }
}
