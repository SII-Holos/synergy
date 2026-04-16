import { Button } from "@ericsanchezok/synergy-ui/button"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@ericsanchezok/synergy-util/encode"
import { Mark } from "@ericsanchezok/synergy-ui/logo"
import { StatusBar } from "@/components/status-bar"

export default function Home() {
  const navigate = useNavigate()

  return (
    <div class="flex flex-col items-center justify-center w-full min-h-full px-6">
      <div class="flex flex-col items-center gap-8 -mt-16">
        <Mark class="size-12 text-icon-base" />
        <Button onClick={() => navigate(`/${base64Encode("global")}/session`)}>Start</Button>
      </div>
      <div class="absolute bottom-0 left-0 right-0">
        <StatusBar />
      </div>
    </div>
  )
}
