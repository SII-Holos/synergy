import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { PasswordField } from "../components/PasswordField"
import { SettingsPage, SettingsSection, SettingsSubsection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingRow"
import type { EmailSettings } from "../types"

export function EmailPanel(props: {
  email: EmailSettings
  onEmailChange: (key: keyof EmailSettings, value: string | boolean) => void
}) {
  const { email, onEmailChange } = props

  return (
    <SettingsPage title="Email" description="Choose the mail account Synergy can use for email tools.">
      <SettingsSection title="Mail tools">
        <SettingRow
          title="Mail tools"
          description="Allow Synergy to send messages and read inbox mail when a tool asks for it."
          stateLabel={email.enabled ? "Enabled" : "Paused"}
          trailing={
            <Switch checked={email.enabled} hideLabel onChange={(v) => onEmailChange("enabled", v)}>
              Mail tools
            </Switch>
          }
        />
      </SettingsSection>

      <SettingsSection title="Sending" description="Set the identity and SMTP connection used for outgoing messages.">
        <SettingsSubsection title="SMTP connection" description="Used only when Synergy sends email.">
          <SettingRow
            title="Host"
            description="SMTP server hostname."
            trailing={
              <TextField
                type="text"
                placeholder="smtp.example.com"
                value={email.smtpHost}
                onChange={(v) => onEmailChange("smtpHost", v)}
              />
            }
          />
          <SettingRow
            title="Port"
            description="SMTP server port."
            trailing={
              <TextField
                type="number"
                placeholder="465"
                value={email.smtpPort}
                onChange={(v) => onEmailChange("smtpPort", v)}
              />
            }
          />
          <SettingRow
            title="Username"
            description="SMTP authentication username."
            trailing={
              <TextField
                type="text"
                placeholder="agent@example.com"
                value={email.smtpUsername}
                onChange={(v) => onEmailChange("smtpUsername", v)}
              />
            }
          />
          <SettingRow
            title="Password"
            description="SMTP authentication password."
            trailing={
              <PasswordField
                label="Password"
                value={email.smtpPassword}
                onChange={(v) => onEmailChange("smtpPassword", v)}
              />
            }
          />
          <SettingRow
            title="From address"
            description="Email address shown as the sender."
            trailing={
              <TextField
                type="text"
                placeholder="agent@example.com"
                value={email.fromAddress}
                onChange={(v) => onEmailChange("fromAddress", v)}
              />
            }
          />
          <SettingRow
            title="Display name"
            description="Name shown as the sender."
            trailing={
              <TextField
                type="text"
                placeholder="Synergy"
                value={email.fromName}
                onChange={(v) => onEmailChange("fromName", v)}
              />
            }
          />
          <SettingRow
            title="Encrypted SMTP"
            description="Use TLS or SSL for outgoing mail."
            stateLabel={email.smtpSecure ? "On" : "Off"}
            trailing={
              <Switch checked={email.smtpSecure} hideLabel onChange={(v) => onEmailChange("smtpSecure", v)}>
                Encrypted SMTP
              </Switch>
            }
          />
        </SettingsSubsection>
      </SettingsSection>

      <SettingsSection title="Reading" description="Optional IMAP access for inbox-reading tools.">
        <SettingsSubsection title="IMAP connection" description="Used only when Synergy reads email.">
          <SettingRow
            title="Host"
            description="IMAP server hostname."
            trailing={
              <TextField
                type="text"
                placeholder="imap.example.com"
                value={email.imapHost}
                onChange={(v) => onEmailChange("imapHost", v)}
              />
            }
          />
          <SettingRow
            title="Port"
            description="IMAP server port."
            trailing={
              <TextField
                type="number"
                placeholder="993"
                value={email.imapPort}
                onChange={(v) => onEmailChange("imapPort", v)}
              />
            }
          />
          <SettingRow
            title="Username"
            description="IMAP authentication username."
            trailing={
              <TextField
                type="text"
                placeholder="agent@example.com"
                value={email.imapUsername}
                onChange={(v) => onEmailChange("imapUsername", v)}
              />
            }
          />
          <SettingRow
            title="Password"
            description="IMAP authentication password."
            trailing={
              <PasswordField
                label="Password"
                value={email.imapPassword}
                onChange={(v) => onEmailChange("imapPassword", v)}
              />
            }
          />
          <SettingRow
            title="Encrypted IMAP"
            description="Use TLS or SSL for inbox access."
            stateLabel={email.imapSecure ? "On" : "Off"}
            trailing={
              <Switch checked={email.imapSecure} hideLabel onChange={(v) => onEmailChange("imapSecure", v)}>
                Encrypted IMAP
              </Switch>
            }
          />
        </SettingsSubsection>
      </SettingsSection>
    </SettingsPage>
  )
}
