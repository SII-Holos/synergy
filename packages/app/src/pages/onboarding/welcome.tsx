import { Mark } from "@ericsanchezok/synergy-ui/logo"
import { useAuth } from "@/context/auth"
import { useHolosLoginPopup } from "@/hooks/use-holos-login-popup"
import { isHostedMode } from "@/utils/runtime"
import { createSignal, onMount, Show, Switch, Match } from "solid-js"

interface LocalCredentials {
  exists: boolean
  agentId?: string
  maskedSecret?: string
}

export default function Welcome(props: { serverUrl: string; callbackUrl: string }) {
  const auth = useAuth()
  const [view, setView] = createSignal<"loading" | "select" | "credentials" | "reveal" | "verifying">("loading")
  const [revealData, setRevealData] = createSignal<{ agentId: string; agentSecret: string } | null>(null)

  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal("")
  const [warning, setWarning] = createSignal("")

  const [localCreds, setLocalCreds] = createSignal<LocalCredentials>({ exists: false })
  const [credScanFailed, setCredScanFailed] = createSignal(false)

  const [credId, setCredId] = createSignal("")
  const [credSecret, setCredSecret] = createSignal("")
  const [showSecret, setShowSecret] = createSignal(false)
  const [copied, setCopied] = createSignal("")

  onMount(async () => {
    try {
      const res = await fetch(`${props.serverUrl}/holos/credentials/status`)
      if (res.ok) {
        const data: LocalCredentials = await res.json()
        setLocalCreds(data)
        if (isHostedMode() && data.exists) {
          await authenticateLocal()
          return
        }
      }
    } catch {
      setCredScanFailed(true)
    }
    setView("select")
  })

  async function authenticateLocal() {
    setView("verifying")
    setError("")
    setWarning("")

    try {
      const res = await fetch(`${props.serverUrl}/holos/verify`)
      if (res.ok) {
        const data = await res.json()
        auth.loginWithToken(data.agentId, { id: data.agentId })
      } else {
        const data = await res.json().catch(() => ({}))
        setWarning(data.message || "Credential mismatch — this identity is not recognized by Holos.")
        setView("select")
      }
    } catch {
      setWarning("Unable to reach Holos to verify credentials. Continuing in standalone mode.")
      setView("select")
    }
  }

  const { trigger: createNewIdentity, connecting: identityLoading } = useHolosLoginPopup({
    serverUrl: props.serverUrl,
    onSuccess: ({ agentId, agentSecret }) => {
      if (agentId && agentSecret) {
        setRevealData({ agentId, agentSecret })
        setView("reveal")
      } else {
        auth.loginWithToken(agentId, { id: agentId })
      }
    },
    onError: (msg) => setError(msg),
  })

  async function loginWithCredentials(e: Event) {
    e.preventDefault()
    if (!credId() || !credSecret()) {
      setError("Please fill in both fields")
      return
    }

    setLoading(true)
    setError("")

    try {
      const res = await fetch(`${props.serverUrl}/holos/credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: credId(), agentSecret: credSecret() }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.message || "Invalid credentials")
        setLoading(false)
        return
      }

      auth.loginWithToken(credId(), { id: credId() })
    } catch {
      setError("Failed to verify credentials")
      setLoading(false)
    }
  }

  function downloadCredentials() {
    const data = revealData()
    if (!data) return

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "synergy-agent-credentials.json"
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  function copyText(text: string, label: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(label)
      setTimeout(() => setCopied(""), 1500)
    })
  }

  function proceedAfterReveal() {
    const data = revealData()
    if (data) {
      auth.loginWithToken(data.agentId, { id: data.agentId })
    }
  }

  function dismissWarningAsGuest() {
    setWarning("")
    auth.loginAsGuest()
  }

  const btnPrimary =
    "h-[46px] w-full flex items-center justify-center rounded-xl bg-text-strong text-background-base font-sans text-[14px] font-medium shadow-sm transition-all hover:opacity-90 hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0"
  const btnSecondary =
    "h-[46px] w-full flex items-center justify-center rounded-xl bg-surface-raised-base text-text-base font-sans text-[14px] font-medium border border-border-weak-base shadow-sm transition-all hover:bg-surface-raised-base-hover hover:text-text-strong active:scale-[0.98] cursor-pointer disabled:opacity-50"
  const inputStyle =
    "w-full bg-surface-inset-base text-text-base rounded-lg px-3 py-2 ring-1 ring-border-base/40 focus:ring-text-interactive-base/50 outline-none font-mono text-sm placeholder:font-sans placeholder:text-text-weaker/50"

  return (
    <div class="fixed inset-0 flex flex-col items-center justify-center bg-background-base selection:bg-surface-raised-stronger selection:text-text-strong">
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-surface-raised-base/40 via-background-base to-background-base -z-10" />

      <div class="flex flex-col items-center w-full max-w-md px-6 animate-in fade-in slide-in-from-bottom-4 duration-1000 ease-out fill-mode-both">
        <div class="flex flex-col items-center mb-10">
          <div class="relative mb-8">
            <Mark class="!size-24 !rounded-2xl shadow-sm ring-1 ring-border-weak-base/50" />
            <div class="absolute -inset-4 bg-surface-raised-base/20 blur-2xl -z-10 rounded-full" />
          </div>

          <h1 class="font-sans text-[42px] font-semibold tracking-[-0.03em] text-text-strong leading-tight mb-3">
            Synergy
          </h1>

          <p class="font-sans text-[15px] font-normal text-text-weaker text-center max-w-sm leading-relaxed">
            Your companion across the digital world
          </p>
        </div>

        <div class="w-full sm:w-[320px] animate-in fade-in slide-in-from-bottom-3 duration-1000 delay-200 ease-out fill-mode-both">
          <Switch>
            {/* Loading state while scanning local credentials */}
            <Match when={view() === "loading"}>
              <div class="flex flex-col items-center gap-3 py-8">
                <div class="size-5 border-2 border-text-weaker/30 border-t-text-weaker rounded-full animate-spin" />
                <p class="text-sm text-text-weaker">Scanning local identity…</p>
              </div>
            </Match>

            {/* Verifying local identity */}
            <Match when={view() === "verifying"}>
              <div class="flex flex-col items-center gap-3 py-8">
                <div class="size-5 border-2 border-text-weaker/30 border-t-text-weaker rounded-full animate-spin" />
                <p class="text-sm text-text-weaker">Handshaking with Holos…</p>
              </div>
            </Match>

            {/* Main selection screen */}
            <Match when={view() === "select"}>
              <div class="flex flex-col gap-3">
                {/* Local identity card */}
                <Show when={localCreds().exists && localCreds().agentId}>
                  <div class="bg-surface-raised-base/50 rounded-xl border border-border-weak-base p-4 mb-1">
                    <div class="flex items-center gap-2 mb-3">
                      <span class="text-text-interactive-base text-sm">◆</span>
                      <span class="text-[11px] uppercase tracking-wider font-semibold text-text-weak">
                        Local Agent Identity
                      </span>
                    </div>
                    <div class="space-y-2">
                      <div class="flex items-baseline gap-2">
                        <span class="text-[11px] text-text-weaker w-12 shrink-0">ID</span>
                        <span class="font-mono text-xs text-text-base break-all">{localCreds().agentId}</span>
                      </div>
                      <div class="flex items-baseline gap-2">
                        <span class="text-[11px] text-text-weaker w-12 shrink-0">Secret</span>
                        <span class="font-mono text-xs text-text-weaker">{localCreds().maskedSecret}</span>
                      </div>
                    </div>
                  </div>
                </Show>

                <Show when={!localCreds().exists}>
                  <Show
                    when={!credScanFailed()}
                    fallback={
                      <p class="text-center text-[13px] text-text-weaker mb-1">
                        Unable to reach server to check local identity.
                      </p>
                    }
                  >
                    <p class="text-center text-[13px] text-text-weaker mb-1">No local agent identity detected.</p>
                  </Show>
                </Show>

                {/* Warning banner for verification failure */}
                <Show when={warning()}>
                  <div class="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2.5 mb-1">
                    <div class="flex items-start gap-2">
                      <span class="text-amber-400 text-sm leading-none mt-0.5">⚠</span>
                      <div>
                        <p class="text-[13px] text-amber-300/90 leading-snug">{warning()}</p>
                        <button
                          type="button"
                          class="text-[12px] text-amber-400/70 hover:text-amber-300 mt-1.5 transition-colors"
                          onClick={dismissWarningAsGuest}
                        >
                          Continue in standalone mode →
                        </button>
                      </div>
                    </div>
                  </div>
                </Show>

                {/* Option 1: Authenticate with local identity (only when local creds exist) */}
                <Show when={localCreds().exists}>
                  <button type="button" class={btnPrimary} onClick={authenticateLocal} disabled={loading()}>
                    Authenticate with local identity
                  </button>
                </Show>

                {/* Option 2: Import registered credentials */}
                <button
                  type="button"
                  class={localCreds().exists ? btnSecondary : btnPrimary}
                  onClick={() => {
                    setError("")
                    setWarning("")
                    setView("credentials")
                  }}
                >
                  Import registered credentials
                </button>

                {/* Option 3: Create a new agent identity */}
                <button type="button" class={btnSecondary} onClick={createNewIdentity} disabled={identityLoading()}>
                  {identityLoading() ? "Connecting…" : "Create a new agent identity"}
                </button>

                {/* Divider */}
                <div class="relative flex items-center py-2 my-1">
                  <div class="flex-grow border-t border-border-weak-base"></div>
                  <span class="shrink-0 px-4 font-sans text-xs text-text-weaker">or</span>
                  <div class="flex-grow border-t border-border-weak-base"></div>
                </div>

                {/* Option 4: Proceed without Holos */}
                <button type="button" class={btnSecondary} onClick={() => auth.loginAsGuest()}>
                  Proceed without Holos
                </button>

                {error() && <p class="text-center text-[13px] text-red-400 mt-2">{error()}</p>}
              </div>
            </Match>

            {/* Import credentials form */}
            <Match when={view() === "credentials"}>
              <form onSubmit={loginWithCredentials} class="flex flex-col gap-4">
                <button
                  type="button"
                  class="self-start text-xs text-text-weaker hover:text-text-base mb-1 flex items-center gap-1 transition-colors"
                  onClick={() => {
                    setError("")
                    setView("select")
                  }}
                >
                  ← Back
                </button>

                <div class="space-y-1">
                  <label class="text-xs font-medium text-text-weak ml-1">Agent ID</label>
                  <input
                    type="text"
                    class={inputStyle}
                    value={credId()}
                    onInput={(e) => setCredId(e.currentTarget.value)}
                    placeholder="e.g. 19e96883-..."
                  />
                </div>

                <div class="space-y-1">
                  <label class="text-xs font-medium text-text-weak ml-1">Agent Secret</label>
                  <input
                    type="password"
                    class={inputStyle}
                    value={credSecret()}
                    onInput={(e) => setCredSecret(e.currentTarget.value)}
                    placeholder="••••••••••••••••"
                  />
                </div>

                {error() && <p class="text-center text-[13px] text-red-400">{error()}</p>}

                <div class="flex gap-3 pt-2">
                  <button
                    type="button"
                    class={btnSecondary}
                    onClick={() => {
                      setError("")
                      setView("select")
                    }}
                  >
                    Cancel
                  </button>
                  <button type="submit" class={btnPrimary} disabled={loading()}>
                    {loading() ? "Verifying…" : "Verify & Sign in"}
                  </button>
                </div>
              </form>
            </Match>

            {/* Credential reveal after creating new identity */}
            <Match when={view() === "reveal" && revealData()}>
              <div class="flex flex-col gap-4 bg-surface-raised-base/50 p-5 rounded-2xl border border-amber-500/20 ring-1 ring-amber-500/10">
                <div class="text-center mb-2">
                  <h3 class="text-amber-400 font-medium text-sm mb-1">⚠ Save Your Credentials</h3>
                  <p class="text-xs text-text-weaker leading-relaxed">
                    Your agent has been created. The secret <strong class="text-text-weak">cannot</strong> be recovered
                    if lost.
                  </p>
                </div>

                <div class="space-y-1">
                  <div class="flex justify-between items-center ml-1">
                    <label class="text-[10px] uppercase tracking-wider font-semibold text-text-weaker">Agent ID</label>
                    <button
                      type="button"
                      onClick={() => copyText(revealData()!.agentId, "id")}
                      class="text-[10px] text-text-interactive-base hover:text-text-interactive-hover transition-colors"
                    >
                      {copied() === "id" ? "Copied!" : "Copy"}
                    </button>
                  </div>
                  <div class="bg-surface-inset-base rounded-lg p-2 font-mono text-xs text-text-base break-all border border-border-base/50 select-all">
                    {revealData()!.agentId}
                  </div>
                </div>

                <div class="space-y-1">
                  <div class="flex justify-between items-center ml-1">
                    <label class="text-[10px] uppercase tracking-wider font-semibold text-text-weaker">
                      Agent Secret
                    </label>
                    <div class="flex gap-3">
                      <button
                        type="button"
                        onClick={() => setShowSecret(!showSecret())}
                        class="text-[10px] text-text-interactive-base hover:text-text-interactive-hover transition-colors"
                      >
                        {showSecret() ? "Hide" : "Show"}
                      </button>
                      <button
                        type="button"
                        onClick={() => copyText(revealData()!.agentSecret, "secret")}
                        class="text-[10px] text-text-interactive-base hover:text-text-interactive-hover transition-colors"
                      >
                        {copied() === "secret" ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  </div>
                  <div class="bg-surface-inset-base rounded-lg p-2 font-mono text-xs text-text-base break-all border border-border-base/50">
                    {showSecret() ? revealData()!.agentSecret : "●".repeat(32)}
                  </div>
                </div>

                <div class="pt-2 flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={downloadCredentials}
                    class="flex items-center justify-center gap-2 text-xs text-text-weak hover:text-text-strong transition-colors py-1"
                  >
                    <span class="text-lg leading-none">↓</span> Download credentials
                  </button>

                  <button type="button" onClick={proceedAfterReveal} class={btnPrimary}>
                    I've saved my credentials, continue →
                  </button>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  )
}
