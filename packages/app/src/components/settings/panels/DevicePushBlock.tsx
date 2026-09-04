import { createEffect, createSignal, For, Show } from "solid-js"
import { useLingui } from "@lingui/solid"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { enableDevicePush, pushCapability } from "@/utils/web-push"
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
} as const

const CATEGORY_KEYS = ["completion", "error", "input"] as const

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

  async function refresh() {
    try {
      const response = await client.list({ throwOnError: true })
      setDevices(response.data ?? [])
    } catch {
      setDevices([])
    }
  }

  createEffect(() => {
    if (capability.kind === "supported") void refresh()
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
      showToast({ type: "success", title: _(copy.enabled) })
      await refresh()
    } catch (error) {
      if ((error as Error)?.name === "NotAllowedError") setPermissionDenied(true)
      showToast({ type: "error", title: _(copy.enableFailed), description: String((error as Error)?.message ?? error) })
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(device: PushSubscriptionInfo) {
    if (device.endpoint) {
      await client.unsubscribe({ endpoint: device.endpoint }, { throwOnError: true }).catch(() => undefined)
    }
    showToast({ type: "success", title: _(copy.removed) })
    await refresh()
  }

  async function handleTest() {
    try {
      await client.test({}, { throwOnError: true })
      showToast({ type: "success", title: _(copy.testSent) })
    } catch {
      showToast({ type: "error", title: _(copy.testFailed) })
    }
  }

  async function toggleCategory(device: PushSubscriptionInfo, key: (typeof CATEGORY_KEYS)[number], value: boolean) {
    const next = { ...device.categories, [key]: value }
    try {
      await client.updateCategories({ id: device.id, pushCategories: next }, { throwOnError: true })
      setDevices((prev) => prev.map((d) => (d.id === device.id ? { ...d, categories: next } : d)))
    } catch {}
  }

  const categoryLabels: Record<(typeof CATEGORY_KEYS)[number], string> = {
    completion: _(copy.completion),
    error: _(copy.error),
    input: _(copy.input),
  }

  const status = (): string => {
    if (capability.kind === "insecure-context") return _(copy.insecure)
    if (capability.kind === "ios-browser-tab") return _(copy.iosTab)
    if (capability.kind === "no-service-worker" || capability.kind === "no-push-manager") return _(copy.unsupported)
    if (permissionDenied()) return _(copy.permissionDenied)
    return devices().length > 0 ? _(copy.enabled) : ""
  }

  return (
    <div class="settings-device-push">
      <SettingRow
        title={_(copy.title)}
        description={_(copy.description)}
        stateLabel={status()}
        trailing={
          <Show when={capability.kind === "supported" && !permissionDenied()} fallback={<span />}>
            <Show
              when={devices().length === 0}
              fallback={
                <Button
                  type="button"
                  variant="secondary"
                  size="small"
                  disabled={busy()}
                  onClick={() => void handleTest()}
                >
                  {_(copy.test)}
                </Button>
              }
            >
              <Button
                type="button"
                variant="secondary"
                size="small"
                disabled={busy()}
                onClick={() => void handleEnable()}
              >
                {_(copy.enable)}
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
                      <span>{categoryLabels[key]}</span>
                      <Switch
                        checked={device.categories[key]}
                        hideLabel
                        onChange={(value) => void toggleCategory(device, key, value)}
                      >
                        {categoryLabels[key]}
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
