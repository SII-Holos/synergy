import { Button } from "@ericsanchezok/synergy-ui/button"
import { Logo } from "@ericsanchezok/synergy-ui/logo"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"

interface ServerConnectionErrorPageProps {
  retrying?: boolean
  serverUrl: string
  onRetry: () => void
  onChangeServer: () => void
}

export function ServerConnectionErrorPage(props: ServerConnectionErrorPageProps) {
  const localServer = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(props.serverUrl)

  return (
    <div class="relative flex-1 h-screen w-screen min-h-0 flex flex-col items-center justify-center bg-background-base font-sans">
      <div class="w-full max-w-xl px-6 flex flex-col items-center gap-8">
        <Logo class="w-58.5 opacity-12 shrink-0" />
        <div class="flex flex-col items-center gap-2 text-center">
          <h1 class="text-lg font-medium text-text-strong">Can’t reach the server</h1>
          <p class="text-sm text-text-weak max-w-md">
            Synergy can’t connect to the backend right now. Retry the connection or switch to a different server.
          </p>
        </div>
        <div class="w-full rounded-2xl border border-border-weak-base bg-surface-raised-base/50 p-4 flex flex-col gap-4">
          <TextField value={props.serverUrl} readOnly copyable label="Server URL" class="font-mono text-xs" />
          <div class="text-sm text-text-weak">
            {localServer
              ? "If you’re running locally, make sure the server is started before retrying."
              : "Verify the server URL and confirm the backend is online before retrying."}
          </div>
        </div>
        <div class="flex items-center gap-3">
          <Button size="large" onClick={props.onRetry} disabled={props.retrying}>
            {props.retrying ? "Retrying..." : "Retry"}
          </Button>
          <Button size="large" variant="secondary" onClick={props.onChangeServer}>
            Change server
          </Button>
        </div>
      </div>
    </div>
  )
}
