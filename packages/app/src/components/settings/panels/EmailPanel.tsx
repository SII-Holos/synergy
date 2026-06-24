import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { SettingRow } from "../components/SettingRow"
import { SectionLabel } from "../components/SectionLabel"
import { PasswordField } from "../components/PasswordField"
import type { EmailSettings } from "../types"
export function EmailPanel(props: {
  email: EmailSettings
  onEmailChange: (key: keyof EmailSettings, value: string | boolean) => void
}) {
  return (
    <div class="ds-content-inner">
      <h1 class="ds-content-title">Email</h1>

      <div class="ds-setting-section">
        <SectionLabel title="Outgoing Email" />
        <p class="ds-section-hint">Configure SMTP for sending emails.</p>
        <div class="ds-email-card">
          <SettingRow
            title="Enabled"
            description="Allow email sending and reading for tools"
            trailing={
              <Switch checked={props.email.enabled} onChange={(value) => props.onEmailChange("enabled", value)} />
            }
          />
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextField
              label="From Address"
              type="text"
              value={props.email.fromAddress}
              onChange={(value) => props.onEmailChange("fromAddress", value)}
            />
            <TextField
              label="From Name"
              type="text"
              value={props.email.fromName}
              onChange={(value) => props.onEmailChange("fromName", value)}
            />
            <TextField
              label="SMTP Host"
              type="text"
              value={props.email.smtpHost}
              onChange={(value) => props.onEmailChange("smtpHost", value)}
            />
            <TextField
              label="SMTP Port"
              type="text"
              value={props.email.smtpPort}
              onChange={(value) => props.onEmailChange("smtpPort", value)}
            />
            <TextField
              label="SMTP Username"
              type="text"
              value={props.email.smtpUsername}
              onChange={(value) => props.onEmailChange("smtpUsername", value)}
            />
            <PasswordField
              label="SMTP Password"
              value={props.email.smtpPassword}
              onChange={(value) => props.onEmailChange("smtpPassword", value)}
            />
          </div>
          <SettingRow
            title="Use TLS/SSL"
            description="Encrypt SMTP connection"
            trailing={
              <Switch checked={props.email.smtpSecure} onChange={(value) => props.onEmailChange("smtpSecure", value)} />
            }
          />
          <p class="ds-section-hint ds-test-info">Test connection will be available in a future update.</p>
        </div>
      </div>

      <div class="ds-setting-section">
        <SectionLabel title="Incoming Email" />
        <p class="ds-section-hint">Configure IMAP for reading emails. Leave empty to disable email reading.</p>
        <div class="ds-email-card">
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <TextField
              label="IMAP Host"
              type="text"
              value={props.email.imapHost}
              onChange={(value) => props.onEmailChange("imapHost", value)}
            />
            <TextField
              label="IMAP Port"
              type="text"
              value={props.email.imapPort}
              onChange={(value) => props.onEmailChange("imapPort", value)}
            />
            <TextField
              label="IMAP Username"
              type="text"
              value={props.email.imapUsername}
              onChange={(value) => props.onEmailChange("imapUsername", value)}
            />
            <PasswordField
              label="IMAP Password"
              value={props.email.imapPassword}
              onChange={(value) => props.onEmailChange("imapPassword", value)}
            />
          </div>
          <SettingRow
            title="Use TLS/SSL"
            description="Encrypt IMAP connection"
            trailing={
              <Switch checked={props.email.imapSecure} onChange={(value) => props.onEmailChange("imapSecure", value)} />
            }
          />
          <p class="ds-section-hint ds-test-info">Test connection will be available in a future update.</p>
        </div>
      </div>
    </div>
  )
}
