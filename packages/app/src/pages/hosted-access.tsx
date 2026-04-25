import { Mark } from "@ericsanchezok/synergy-ui/logo"
import { Spinner } from "@ericsanchezok/synergy-ui/spinner"
import { createEffect, createMemo, createSignal, Match, onCleanup, onMount, Show, Switch, type JSX } from "solid-js"
import { appAccessFromUrlParam, callbackUrlFor, controlApiBase, trimSlashes, type AppAccess } from "@/utils/runtime"
import { AppWithAccess } from "@/app-access"

interface HostedProfile {
  id: string
  name?: string
  email?: string
  is_admin?: boolean
}

type HostedView =
  | "checking-profile"
  | "checking-agent"
  | "invite"
  | "verifying-invite"
  | "provisioning"
  | "provision-failed"
  | "ready"
  | "error"

interface HostedAgentResponse {
  code: number
  message?: string
  data?: {
    agent_id: string | null
    attach_url?: string
    attachUrl?: string
    url?: string
  }
}

interface HostedInviteResponse {
  code: number
  message?: string
  data?: {
    agent_id: string | null
    attach_url?: string
    attachUrl?: string
    url?: string
    existed: boolean
  }
}

interface HostedProfileResponse {
  code: number
  message?: string
  data?: {
    logged_in?: boolean
    user_profile?: HostedProfile
  }
}

function endpoint(path: string) {
  return `${controlApiBase()}${path}`
}

function consoleOrigin() {
  return trimSlashes(window.location.origin)
}

function attachUrlForAgent(agentId: string) {
  return `${consoleOrigin()}/agents/${agentId}`
}

function loginRedirectUrl() {
  const loginUrl = import.meta.env.VITE_HOLOS_LOGIN_URL || "https://www.holosai.io/login.html"
  const redirect = encodeURIComponent(new URL("/", window.location.origin).toString())
  return `${loginUrl}?redirect=${redirect}`
}

function redirectToHolosLogin() {
  const target = loginRedirectUrl()

  try {
    if (window.top && window.top !== window) {
      window.top.location.replace(target)
      return
    }
  } catch {}

  window.location.replace(target)
}

async function readJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

async function fetchHostedProfile() {
  const response = await fetch(endpoint("/api/v1/holos/user/profile"), {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  })

  if (response.status === 401) {
    redirectToHolosLogin()
    return {
      response,
      body: undefined,
    }
  }

  return {
    response,
    body: await readJson<HostedProfileResponse>(response),
  }
}

async function fetchMyAgent() {
  const response = await fetch(endpoint("/api/v1/holos/synergy/me/agent"), {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  })
  return {
    response,
    body: await readJson<HostedAgentResponse>(response),
  }
}

async function verifyInvite(code: string) {
  const response = await fetch(endpoint("/api/v1/holos/synergy/invite-codes/verify"), {
    method: "POST",
    credentials: "include",
    headers: {
      accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ code }),
  })
  return {
    response,
    body: await readJson<HostedInviteResponse>(response),
  }
}

async function checkHealth(attachUrl: string) {
  const response = await fetch(`${attachUrl}/global/health`, {
    credentials: "include",
    headers: {
      accept: "application/json",
    },
  })
  return response.ok
}

function accessFromAgentData(data: HostedAgentResponse["data"] | HostedInviteResponse["data"]): AppAccess | undefined {
  if (!data) return
  const attachUrl =
    data.attachUrl || data.attach_url || data.url || (data.agent_id ? attachUrlForAgent(data.agent_id) : "")
  if (!attachUrl) return
  return {
    attachUrl: trimSlashes(attachUrl),
    callbackUrl: callbackUrlFor(attachUrl),
  }
}

function LoadingCard(props: { title: string; description: string; detail?: string }) {
  return (
    <div class="flex flex-col items-center gap-3 py-8">
      <div class="relative flex items-center justify-center size-12">
        <div class="absolute size-12 rounded-full bg-surface-raised-base/40 blur-md animate-pulse" />
        <div class="absolute size-9 rounded-full border border-border-weak-base/60" />
        <Spinner class="relative size-5 text-text-strong" />
      </div>
      <p class="text-sm text-text-base text-center">{props.title}</p>
      <p class="text-[13px] text-text-weaker text-center max-w-sm leading-relaxed">{props.description}</p>
      <Show when={props.detail}>
        <p class="text-[12px] text-text-weaker/80 text-center">{props.detail}</p>
      </Show>
    </div>
  )
}

function HostedShell(props: { title: string; subtitle: string; description?: string; children: JSX.Element }) {
  return (
    <div class="fixed inset-0 flex flex-col items-center justify-center bg-background-base selection:bg-surface-raised-stronger selection:text-text-strong">
      <div class="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-surface-raised-base/40 via-background-base to-background-base -z-10" />
      <div class="flex flex-col items-center w-full max-w-md px-6 animate-in fade-in slide-in-from-bottom-4 duration-1000 ease-out fill-mode-both">
        <div class="flex flex-col items-center mb-10">
          <div class="relative mb-8">
            <Mark class="!size-24 !rounded-2xl shadow-sm ring-1 ring-border-weak-base/50" />
            <div class="absolute -inset-4 bg-surface-raised-base/20 blur-2xl -z-10 rounded-full" />
          </div>
          <h1 class="font-sans text-[42px] font-semibold text-text-strong leading-tight mb-3">Synergy</h1>
          <p class="mt-1 font-sans text-[15px] font-normal text-text-weaker text-center max-w-sm leading-relaxed">
            {props.subtitle}
          </p>
        </div>
        <div class="w-full sm:w-[360px] animate-in fade-in slide-in-from-bottom-3 duration-1000 delay-200 ease-out fill-mode-both">
          <div class="flex flex-col gap-4 rounded-2xl border border-border-weak-base bg-surface-raised-base/40 p-5">
            <div class="flex flex-col gap-1">
              <h2 class="text-[18px] font-medium text-text-strong">{props.title}</h2>
              <Show when={props.description}>
                <p class="text-[13px] text-text-weaker leading-relaxed">{props.description}</p>
              </Show>
            </div>
            {props.children}
          </div>
        </div>
      </div>
    </div>
  )
}

function HostedAccessGate() {
  const [view, setView] = createSignal<HostedView>("checking-profile")
  const [error, setError] = createSignal("")
  const [inviteCode, setInviteCode] = createSignal("")
  const [agentId, setAgentId] = createSignal<string | null>(null)
  const [profile, setProfile] = createSignal<HostedProfile | null>(null)
  const [access, setAccess] = createSignal<AppAccess | undefined>()
  const [pollAttempt, setPollAttempt] = createSignal(0)

  const readyAccess = createMemo(() => (view() === "ready" ? access() : undefined))

  async function loadAgent() {
    setView("checking-agent")
    setError("")

    const { response, body } = await fetchMyAgent()
    if (!response.ok || body?.code !== 0) {
      throw new Error(body?.message || `Failed to fetch your Synergy agent (${response.status})`)
    }

    const nextAgentId = body.data?.agent_id ?? null
    setAgentId(nextAgentId)
    setAccess(accessFromAgentData(body.data))
    setView(nextAgentId || access() ? "ready" : "invite")
  }

  async function bootstrap() {
    setView("checking-profile")
    setError("")

    const { response, body } = await fetchHostedProfile()
    if (response.status === 401) return

    if (!response.ok) {
      throw new Error(body?.message || `Failed to verify your Holos login (${response.status})`)
    }

    if (body?.code !== 0 || body.data?.logged_in !== true) {
      redirectToHolosLogin()
      return
    }

    setProfile(body.data?.user_profile ?? null)
    await loadAgent()
  }

  onMount(() => {
    void bootstrap().catch((err) => {
      setError(err instanceof Error ? err.message : "Unable to load your Synergy access.")
      setView("error")
    })
  })

  createEffect(() => {
    if (view() !== "provisioning") return

    const currentAccess = access()
    if (!currentAccess) {
      setError("Synergy agent activation did not return an access URL.")
      setView("error")
      return
    }

    pollAttempt()
    const deadline = Date.now() + 120_000
    let cancelled = false
    let timer: number | undefined

    const run = async () => {
      const ok = await checkHealth(currentAccess.attachUrl).catch(() => false)
      if (cancelled) return
      if (ok) {
        setView("ready")
        return
      }
      if (Date.now() >= deadline) {
        setView("provision-failed")
        return
      }
      timer = window.setTimeout(() => void run(), 5_000)
    }

    void run()

    onCleanup(() => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    })
  })

  async function submitInvite(event: Event) {
    event.preventDefault()
    const value = inviteCode().trim()
    if (!value) {
      setError("Please enter your invite code.")
      return
    }

    setView("verifying-invite")
    setError("")

    try {
      const { response, body } = await verifyInvite(value)
      if (!response.ok || body?.code !== 0) {
        throw new Error(body?.message || "Invite code verification failed.")
      }

      const nextAccess = accessFromAgentData(body.data)
      if (!nextAccess) {
        throw new Error("Invite verification succeeded but no access URL was returned.")
      }

      setAgentId(body.data?.agent_id ?? null)
      setAccess(nextAccess)
      setView(body.data?.existed ? "ready" : "provisioning")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invite code verification failed.")
      setView("invite")
    }
  }

  function retryProvisioning() {
    setError("")
    setPollAttempt((value) => value + 1)
    setView("provisioning")
  }

  const inputStyle =
    "w-full bg-surface-inset-base text-text-base rounded-lg px-3 py-2 ring-1 ring-border-base/40 focus:ring-text-interactive-base/50 outline-none font-mono text-sm placeholder:font-sans placeholder:text-text-weaker/50"
  const btnPrimary =
    "h-[46px] w-full flex items-center justify-center rounded-xl bg-text-strong text-background-base font-sans text-[14px] font-medium shadow-sm transition-all hover:opacity-90 active:scale-[0.98] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"

  return (
    <Switch>
      <Match when={readyAccess()}>{(resolvedAccess) => <AppWithAccess access={resolvedAccess()} />}</Match>
      <Match when={view() === "error"}>
        <HostedShell title="Unable to continue" subtitle="Your workspace could not be prepared just yet.">
          <div class="flex flex-col gap-4">
            <p class="text-[13px] text-text-weaker leading-relaxed">{error()}</p>
            <button type="button" class={btnPrimary} onClick={() => void bootstrap()}>
              Try again
            </button>
          </div>
        </HostedShell>
      </Match>
      <Match when={view() === "checking-profile"}>
        <HostedShell title="Checking your Holos login" subtitle="Your companion across the digital world">
          <LoadingCard
            title="Verifying your session..."
            description="We are checking whether your Holos account is signed in for Synergy Console."
          />
        </HostedShell>
      </Match>
      <Match when={view() === "checking-agent"}>
        <HostedShell title="Looking up your Synergy Agent" subtitle="Your companion across the digital world">
          <LoadingCard
            title="Checking your workspace..."
            description="We are finding the Synergy Agent attached to your Holos account."
          />
        </HostedShell>
      </Match>
      <Match when={view() === "verifying-invite"}>
        <HostedShell title="Verifying invite code" subtitle="Your companion across the digital world">
          <LoadingCard
            title="Validating your access..."
            description="We are verifying your invite code and preparing your Synergy Agent."
          />
        </HostedShell>
      </Match>
      <Match when={view() === "provisioning"}>
        <HostedShell title="Preparing your Synergy Agent" subtitle="Your companion across the digital world">
          <LoadingCard
            title="Almost there..."
            description="Your Synergy Agent is being activated. This can take a minute or two."
            detail={agentId() ? `Agent ID: ${agentId()}` : undefined}
          />
        </HostedShell>
      </Match>
      <Match when={view() === "provision-failed"}>
        <HostedShell title="Still starting up" subtitle="Your companion across the digital world">
          <div class="flex flex-col gap-4">
            <p class="text-[13px] text-text-weaker leading-relaxed">
              Your Synergy Agent is taking longer than expected to come online. Retry the health check to keep waiting.
            </p>
            <button type="button" class={btnPrimary} onClick={retryProvisioning}>
              Retry
            </button>
          </div>
        </HostedShell>
      </Match>
      <Match when={view() === "invite"}>
        <HostedShell
          title={`Hi ${profile()?.name ?? "there"}, welcome to Synergy`}
          subtitle="Your companion across the digital world"
          description="Enter your invite code"
        >
          <form onSubmit={submitInvite} class="flex flex-col gap-4">
            <input
              type="text"
              class={inputStyle}
              value={inviteCode()}
              onInput={(event) => setInviteCode(event.currentTarget.value.toUpperCase())}
              autocomplete="one-time-code"
            />
            <Show when={error()}>
              <p class="text-center text-[13px] text-red-400">{error()}</p>
            </Show>
            <button type="submit" class={btnPrimary}>
              Continue
            </button>
          </form>
        </HostedShell>
      </Match>
    </Switch>
  )
}

export function HostedAppInterface() {
  const overrideAccess = appAccessFromUrlParam()
  if (overrideAccess) {
    return <AppWithAccess access={overrideAccess} />
  }

  return <HostedAccessGate />
}
