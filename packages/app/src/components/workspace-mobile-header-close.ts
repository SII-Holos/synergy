import { useParams, useNavigate } from "@solidjs/router"
import { useLayout } from "@/context/layout"

export function useWorkspaceMobileHeaderClose() {
  const navigate = useNavigate()
  const layout = useLayout()
  const params = useParams()

  return () => {
    const dir = params.dir
    if (dir) {
      const sessionKey = `${dir}${params.id ? "/" + params.id : ""}`
      layout.surface(sessionKey, "side").close()
    } else {
      navigate(-1)
    }
  }
}
