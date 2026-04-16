import { createSignal } from "solid-js"
import type { HolosProfile } from "@ericsanchezok/synergy-sdk"
import { Button } from "@ericsanchezok/synergy-ui/button"
import { showToast } from "@ericsanchezok/synergy-ui/toast"
import { Dialog } from "@ericsanchezok/synergy-ui/dialog"
import { useDialog } from "@ericsanchezok/synergy-ui/context/dialog"
import { useGlobalSDK } from "@/context/global-sdk"

export function EditProfileDialog(props: { profile: HolosProfile; onSaved: () => void; onRerunSetup: () => void }) {
  const dialog = useDialog()
  const globalSDK = useGlobalSDK()
  const [name, setName] = createSignal(props.profile.name)
  const [bio, setBio] = createSignal(props.profile.bio ?? "")
  const [saving, setSaving] = createSignal(false)
  const [resetting, setResetting] = createSignal(false)

  async function handleSave() {
    if (!name().trim()) {
      showToast({ title: "Name cannot be empty" })
      return
    }

    setSaving(true)
    try {
      await globalSDK.client.holos.profile.update({
        name: name().trim(),
        bio: bio().trim(),
      })
      showToast({ title: "Profile updated" })
      props.onSaved()
      dialog.close()
    } catch (e: any) {
      showToast({ title: "Failed to save profile", description: e.message })
    } finally {
      setSaving(false)
    }
  }

  async function handleRerunSetup() {
    if (!confirm("Re-run the onboarding setup? Your current profile data will be preserved.")) return

    setResetting(true)
    try {
      await globalSDK.client.holos.profile.reset()
      showToast({ title: "Setup will restart" })
      props.onRerunSetup()
      dialog.close()
    } catch (e: any) {
      showToast({ title: "Failed to reset setup", description: e.message })
    } finally {
      setResetting(false)
    }
  }

  return (
    <Dialog title="Edit Profile">
      <div class="flex flex-col gap-5 px-5 py-4">
        <div class="flex flex-col gap-1.5">
          <label class="text-12-medium text-text-weak">Name</label>
          <input
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSave()
            }}
            class="bg-surface-inset-base rounded-lg px-3 py-2 ring-1 ring-border-base/40 focus:ring-text-interactive-base/50 outline-none text-14-regular text-text-base w-full transition-shadow"
            disabled={saving() || resetting()}
            autofocus
          />
        </div>

        <div class="flex flex-col gap-1.5">
          <label class="text-12-medium text-text-weak">Bio</label>
          <textarea
            value={bio()}
            onInput={(e) => setBio(e.currentTarget.value)}
            rows={3}
            class="bg-surface-inset-base rounded-lg px-3 py-2 ring-1 ring-border-base/40 focus:ring-text-interactive-base/50 outline-none text-13-regular text-text-base w-full transition-shadow resize-none leading-relaxed"
            disabled={saving() || resetting()}
          />
        </div>
      </div>

      <div class="flex items-center justify-between px-5 py-3 border-t border-border-base/20 shrink-0">
        <button
          type="button"
          onClick={handleRerunSetup}
          disabled={resetting() || saving()}
          class="text-12-medium text-text-weak hover:text-text-base transition-colors disabled:opacity-50"
        >
          {resetting() ? "Resetting..." : "Re-run setup"}
        </button>

        <div class="flex items-center gap-2">
          <Button variant="ghost" size="large" onClick={() => dialog.close()} disabled={saving() || resetting()}>
            Cancel
          </Button>
          <Button variant="primary" size="large" onClick={handleSave} disabled={saving() || resetting()}>
            {saving() ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
