import { createEffect, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { enableDevicePush, pushCapability, PushPermissionDeniedError } from "@/utils/web-push"
import type { PushSubscriptionInfo } from "@ericsanchezok/synergy-sdk"
import { SettingRow } from "../components/SettingRow"

const copy = {
  title: { id: "settings.general.devicePush.title", message: "Device push" },
  description: {
    id: "settings.general.devicePush.description",
    message: "Receive completion, error, and input-required notifications on this device through the browser.",
  },
  unsupported: {
    id: "settings.general.devicePush.unsupported",
    message: "Push is not supported in this browser",
  },
  insecure: {
    id: "settings.general.devicePush.insecure",
    message: "Push requires a secure (HTTPS) connection",
  },
  iosTab: {
    id: "settings.general.devicePush.iosTab",
    message: "On iOS, add this site to your Home Screen and open it as an app to enable push",
  },
  permissionDenied: {
    id: "settings.general.devicePush.permissionDenied",
    message: "Notification permission was denied in browser settings",
  },
  enable: { id: "settings.general.devicePush.enable", message: "Enable push" },
  enabled: { id: "settings.general.devicePush.enabled", message: "Push enabled on this device" },
  test: { id: "settings.general.devicePush.test", message: "Send test" },
  remove: { id: "settings.general.devicePush.remove", message: "Remove" },
  completion: { id: "settings.general.devicePush.completion", message: "Completions" },
  error: { id: "settings.general.devicePush.error", message: "Errors" },
  input: { id: "settings.general.devicePush.input", message: "Needs input" },
  enableFailed: { id: "settings.general.devicePush.enableFailed", message: "Could not enable push" },
  testSent: { id: "settings.general.devicePush.testSent", message: "Test notification sent" },
  testFailed: { id: "settings.general.devicePush.testFailed", message: "Test notification failed" },
  removed: { id: "settings.general.devicePush.removed", message: "Device removed" },
  removeFailed: {
    id: "settings.general.devicePush.removeFailed",
    message: "Could not remove device; it is still subscribed to pushes",
  },
} as const

const CATEGORY_KEYS = ["completion", "error", "input"] as const
type CategoryKey = (typeof CATEGORY_KEYS)[number]

async function localSubscription(): Promise<PushSubscription | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  return (await registration?.pushManager.getSubscription().catch(() => undefined)) ?? null
}

export function DevicePushBlock() {
  const { _ } = useLingui()
  const globalSDK = useGlobalSDK()
  const client = globalSDK.client.push
  const capability = pushCapability()

  const [devices, setDevices] = createSignal<PushSubscriptionInfo[]>([])
  const [busy, setBusy] = createSignal(false)
  const [permissionDenied, setPermissionDenied] = createSignal(
    typeof Notification !== "undefined" && Notification.permission === "denied",
  )
  // Local enablement comes from this browser's own pushManager subscription;
  // `devices` is the server-wide list used only for device management, so a
  // second browser must not think push is already enabled here.
  const [localEnabled, setLocalEnabled] = createSignal(false)
  // Serialize per-device category writes: concurrent PATCHes built from stale
  // snapshots could restore each other's old values.
  const categoryQueues = new Map<string, Promise<void>>()

  // Reactive translations: recompute on every render path so a live locale
  // switch updates the category labels (translation calls stay literal).
  const categoryLabels = () =>
    ({
      completion: _(copy.completion),
      error: _(copy.error),
      input: _(copy.input),
    }) as Record<CategoryKey, string>

  async function refreshDevices() {
    try {
      const response = await client.list({ throwOnError: true })
      setDevices(response.data ?? [])
    } catch {
      setDevices([])
    }
  }

  async function refreshLocal() {
    const subscription = await localSubscription()
    setLocalEnabled(Boolean(subscription))
  }

  createEffect(() => {
    if (capability.kind === "supported") {
      void refreshDevices()
      void refreshLocal()
    }
  })

  async function handleEnable() {
    if (capability.kind !== "supported" || busy()) return
    setBusy(true)
    try {
      await enableDevicePush(
        {
          getVapidKey: () => client.getVapidKey({ throwOnError: true }).then((r) => r.data!),
          subscribe: (body) => client.subscribe(body, { throwOnError: true }),
          unsubscribe: (body) => client.unsubscribe(body, { throwOnError: true }),
        },
        { deviceLabel: platformLabel() },
      )
      setPermissionDenied(false)
      setLocalEnabled(true)
      showToast({ type: "success", title: _(copy.enabled) })
      await refreshDevices()
    } catch (error) {
      if (error instanceof PushPermissionDeniedError || (error as Error)?.name === "NotAllowedError") {
        setPermissionDenied(true)
      }
      showToast({ type: "error", title: _(copy.enableFailed), description: String((error as Error)?.message ?? error) })
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(device: PushSubscriptionInfo) {
    setBusy(true)
    try {
      if (device.endpoint) {
        // Surface transport failures: the server record stays active (and the
        // device keeps receiving pushes) unless deletion is confirmed.
        await client.unsubscribe({ endpoint: device.endpoint }, { throwOnError: true })
      }
      // If this row is the current browser's subscription, drop it locally too.
      const local = await localSubscription()
      if (local && device.endpoint) {
        const json = local.toJSON() as { endpoint?: string }
        if (json.endpoint === device.endpoint) {
          await local.unsubscribe().catch(() => undefined)
          setLocalEnabled(false)
        }
      }
      showToast({ type: "success", title: _(copy.removed) })
    } catch {
      showToast({ type: "error", title: _(copy.removeFailed) })
    } finally {
      setBusy(false)
      await refreshDevices()
      await refreshLocal()
    }
  }

  async function handleTest() {
    try {
      await client.test({}, { throwOnError: true })
      showToast({ type: "success", title: _(copy.testSent) })
    } catch {
      showToast({ type: "error", title: _(copy.testFailed) })
    }
  }

  function toggleCategory(device: PushSubscriptionInfo, key: CategoryKey, value: boolean) {
    // Optimistic local flip for immediate feedback; writes are serialized per
    // device and each request is built from the latest applied state.
    setDevices((prev) =>
      prev.map((d) => (d.id === device.id ? { ...d, categories: { ...d.categories, [key]: value } } : d)),
    )
    const previous = categoryQueues.get(device.id) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const latest = devices().find((d) => d.id === device.id)
        if (!latest) return
        await client.updateCategories({ id: device.id, pushCategories: latest.categories }, { throwOnError: true })
      })
      .catch(() => {
        // The optimistic state may now disagree with the server; reload.
        return refreshDevices()
      })
    categoryQueues.set(device.id, next)
  }

  const status = (): string => {
    if (capability.kind === "insecure-context") return _(copy.insecure)
    if (capability.kind === "ios-browser-tab") return _(copy.iosTab)
    if (capability.kind === "no-service-worker" || capability.kind === "no-push-manager") return _(copy.unsupported)
    if (permissionDenied()) return _(copy.permissionDenied)
    return localEnabled() ? _(copy.enabled) : ""
  }

  return (
    <div class="settings-device-push">
      <SettingRow
        title={_(copy.title)}
        description={_(copy.description)}
        stateLabel={status()}
        trailing={
          <Show when={capability.kind === "supported"} fallback={<span />}>
            <Show
              when={localEnabled()}
              fallback={
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={busy() || permissionDenied()}
                  onClick={() => void handleEnable()}
                >
                  {_(copy.enable)}
                </Button>
              }
            >
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={busy()}
                onClick={() => void handleTest()}
              >
                {_(copy.test)}
              </Button>
            </Show>
          </Show>
        }
      />
      <Show when={devices().length > 0}>
        <For each={devices()}>
          {(device) => (
            <div class="settings-device-push-device">
              <span class="settings-row-title">{device.deviceLabel ?? device.endpoint}</span>
              <div class="settings-device-push-controls">
                <For each={CATEGORY_KEYS}>
                  {(key) => (
                    <div class="settings-device-push-toggle">
                      <span>{categoryLabels()[key]}</span>
                      <Switch
                        checked={device.categories[key]}
                        hideLabel
                        disabled={busy()}
                        onChange={(value) => toggleCategory(device, key, value)}
                      >
                        {categoryLabels()[key]}
                      </Switch>
                    </div>
                  )}
                </For>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  disabled={busy()}
                  onClick={() => void handleRemove(device)}
                >
                  {_(copy.remove)}
                </Button>
              </div>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

function platformLabel(): string | undefined {
  try {
    const ua = navigator.userAgent
    if (/iphone|ipad|ipod/i.test(ua)) return "iPhone"
    if (/android/i.test(ua)) return "Android"
    if (/mac/i.test(ua)) return "Mac"
    if (/windows/i.test(ua)) return "Windows"
    if (/linux/i.test(ua)) return "Linux"
    return "Web"
  } catch {
    return undefined
  }
}
