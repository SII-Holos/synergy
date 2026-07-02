import { Icon } from "@ericsanchezok/synergy-ui/icon"
import { getSemanticIcon } from "@ericsanchezok/synergy-ui/semantic-icon"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { PasswordField } from "../components/PasswordField"
import { SettingsPage } from "../components/SettingsPrimitives"
import type { EmailSettings } from "../types"

export function EmailPanel(props: {
  email: EmailSettings
  onEmailChange: (key: keyof EmailSettings, value: string | boolean) => void
}) {
  return (
    <SettingsPage title="Email" description="Choose the mail account Synergy can use for email tools.">
      <div class="settings-integration-shell settings-email-shell">
        <section class="settings-integration-section">
          <div class="settings-integration-row settings-integration-row-compact">
            <div class="settings-integration-row-copy">
              <span class="settings-integration-row-icon">
                <Icon name={getSemanticIcon("settings.email")} size="small" />
              </span>
              <div>
                <div class="settings-integration-row-title">Mail tools</div>
                <div class="settings-integration-row-description">
                  Allow Synergy to send messages and read inbox mail when a tool asks for it.
                </div>
              </div>
            </div>
            <div class="settings-integration-row-control">
              <span class="settings-integration-state">{props.email.enabled ? "Enabled" : "Paused"}</span>
              <Switch
                checked={props.email.enabled}
                hideLabel
                onChange={(value) => props.onEmailChange("enabled", value)}
              >
                Mail tools
              </Switch>
            </div>
          </div>
        </section>

        <section class="settings-integration-section">
          <div class="settings-integration-section-heading">
            <h2>Sending</h2>
            <p>Set the identity and SMTP connection used for outgoing messages.</p>
          </div>
          <div class="settings-integration-form-grid settings-integration-form-grid-two">
            <TextField
              label="From address"
              type="text"
              placeholder="agent@example.com"
              value={props.email.fromAddress}
              onChange={(value) => props.onEmailChange("fromAddress", value)}
            />
            <TextField
              label="Display name"
              type="text"
              placeholder="Synergy"
              value={props.email.fromName}
              onChange={(value) => props.onEmailChange("fromName", value)}
            />
          </div>

          <div class="settings-email-connection-block">
            <div class="settings-email-connection-heading">
              <span>SMTP connection</span>
              <p>Used only when Synergy sends email.</p>
            </div>
            <div class="settings-integration-form-grid settings-integration-form-grid-two">
              <TextField
                label="Host"
                type="text"
                placeholder="smtp.example.com"
                value={props.email.smtpHost}
                onChange={(value) => props.onEmailChange("smtpHost", value)}
              />
              <TextField
                label="Port"
                type="number"
                placeholder="465"
                value={props.email.smtpPort}
                onChange={(value) => props.onEmailChange("smtpPort", value)}
              />
              <TextField
                label="Username"
                type="text"
                placeholder="agent@example.com"
                value={props.email.smtpUsername}
                onChange={(value) => props.onEmailChange("smtpUsername", value)}
              />
              <PasswordField
                label="Password"
                value={props.email.smtpPassword}
                onChange={(value) => props.onEmailChange("smtpPassword", value)}
              />
            </div>
            <EmailSecureRow
              title="Encrypted SMTP"
              description="Use TLS or SSL for outgoing mail."
              checked={props.email.smtpSecure}
              onChange={(value) => props.onEmailChange("smtpSecure", value)}
            />
          </div>
        </section>

        <section class="settings-integration-section">
          <div class="settings-integration-section-heading">
            <h2>Reading</h2>
            <p>Optional IMAP access for inbox-reading tools. Leave the host empty to keep reading off.</p>
          </div>
          <div class="settings-email-connection-block">
            <div class="settings-email-connection-heading">
              <span>IMAP connection</span>
              <p>Used only when Synergy reads email.</p>
            </div>
            <div class="settings-integration-form-grid settings-integration-form-grid-two">
              <TextField
                label="Host"
                type="text"
                placeholder="imap.example.com"
                value={props.email.imapHost}
                onChange={(value) => props.onEmailChange("imapHost", value)}
              />
              <TextField
                label="Port"
                type="number"
                placeholder="993"
                value={props.email.imapPort}
                onChange={(value) => props.onEmailChange("imapPort", value)}
              />
              <TextField
                label="Username"
                type="text"
                placeholder="agent@example.com"
                value={props.email.imapUsername}
                onChange={(value) => props.onEmailChange("imapUsername", value)}
              />
              <PasswordField
                label="Password"
                value={props.email.imapPassword}
                onChange={(value) => props.onEmailChange("imapPassword", value)}
              />
            </div>
            <EmailSecureRow
              title="Encrypted IMAP"
              description="Use TLS or SSL for inbox access."
              checked={props.email.imapSecure}
              onChange={(value) => props.onEmailChange("imapSecure", value)}
            />
          </div>
        </section>
      </div>
    </SettingsPage>
  )
}

function EmailSecureRow(props: {
  title: string
  description: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div class="settings-integration-row settings-email-secure-row">
      <div>
        <div class="settings-integration-row-title">{props.title}</div>
        <div class="settings-integration-row-description">{props.description}</div>
      </div>
      <div class="settings-integration-row-control">
        <span class="settings-integration-state">{props.checked ? "On" : "Off"}</span>
        <Switch checked={props.checked} hideLabel onChange={props.onChange}>
          {props.title}
        </Switch>
      </div>
    </div>
  )
}
