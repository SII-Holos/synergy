import { useLingui } from "@lingui/solid"
import { Switch } from "@ericsanchezok/synergy-ui/switch"
import { TextField } from "@ericsanchezok/synergy-ui/text-field"
import { PasswordField } from "../components/PasswordField"
import { SettingsPage, SettingsSection, SettingsSubsection } from "../components/SettingsPrimitives"
import { SettingRow } from "../components/SettingRow"
import type { EmailSettings } from "../types"

const pageTitle = { id: "settings.email.page.title", message: "Email" }
const pageDesc = { id: "settings.email.page.desc", message: "Choose the mail account Synergy can use for email tools." }
const mailToolsSection = { id: "settings.email.mailTools.title", message: "Mail tools" }
const mailToolsRowTitle = { id: "settings.email.mailTools.row.title", message: "Mail tools" }
const mailToolsRowDesc = {
  id: "settings.email.mailTools.row.desc",
  message: "Allow Synergy to send messages and read inbox mail when a tool asks for it.",
}
const enabledLabel = { id: "settings.email.state.enabled", message: "Enabled" }
const pausedLabel = { id: "settings.email.state.paused", message: "Paused" }
const sendingSection = { id: "settings.email.sending.title", message: "Sending" }
const sendingSectionDesc = {
  id: "settings.email.sending.desc",
  message: "Set the identity and SMTP connection used for outgoing messages.",
}
const smtpSubTitle = { id: "settings.email.smtp.title", message: "SMTP connection" }
const smtpSubDesc = { id: "settings.email.smtp.desc", message: "Used only when Synergy sends email." }
const smtpHostTitle = { id: "settings.email.smtp.host.title", message: "Host" }
const smtpHostDesc = { id: "settings.email.smtp.host.desc", message: "SMTP server hostname." }
const smtpPortTitle = { id: "settings.email.smtp.port.title", message: "Port" }
const smtpPortDesc = { id: "settings.email.smtp.port.desc", message: "SMTP server port." }
const smtpUserTitle = { id: "settings.email.smtp.user.title", message: "Username" }
const smtpUserDesc = { id: "settings.email.smtp.user.desc", message: "SMTP authentication username." }
const smtpPassTitle = { id: "settings.email.smtp.pass.title", message: "Password" }
const smtpPassDesc = { id: "settings.email.smtp.pass.desc", message: "SMTP authentication password." }
const fromAddrTitle = { id: "settings.email.smtp.fromAddr.title", message: "From address" }
const fromAddrDesc = { id: "settings.email.smtp.fromAddr.desc", message: "Email address shown as the sender." }
const fromNameTitle = { id: "settings.email.smtp.fromName.title", message: "Display name" }
const fromNameDesc = { id: "settings.email.smtp.fromName.desc", message: "Name shown as the sender." }
const encSmtpTitle = { id: "settings.email.smtp.enc.title", message: "Encrypted SMTP" }
const encSmtpDesc = { id: "settings.email.smtp.enc.desc", message: "Use TLS or SSL for outgoing mail." }
const onLabel = { id: "settings.email.state.on", message: "On" }
const offLabel = { id: "settings.email.state.off", message: "Off" }
const readingSection = { id: "settings.email.reading.title", message: "Reading" }
const readingSectionDesc = {
  id: "settings.email.reading.desc",
  message: "Optional IMAP access for inbox-reading tools.",
}
const imapSubTitle = { id: "settings.email.imap.title", message: "IMAP connection" }
const imapSubDesc = { id: "settings.email.imap.desc", message: "Used only when Synergy reads email." }
const imapHostTitle = { id: "settings.email.imap.host.title", message: "Host" }
const imapHostDesc = { id: "settings.email.imap.host.desc", message: "IMAP server hostname." }
const imapPortTitle = { id: "settings.email.imap.port.title", message: "Port" }
const imapPortDesc = { id: "settings.email.imap.port.desc", message: "IMAP server port." }
const imapUserTitle = { id: "settings.email.imap.user.title", message: "Username" }
const imapUserDesc = { id: "settings.email.imap.user.desc", message: "IMAP authentication username." }
const imapPassTitle = { id: "settings.email.imap.pass.title", message: "Password" }
const imapPassDesc = { id: "settings.email.imap.pass.desc", message: "IMAP authentication password." }
const encImapTitle = { id: "settings.email.imap.enc.title", message: "Encrypted IMAP" }
const encImapDesc = { id: "settings.email.imap.enc.desc", message: "Use TLS or SSL for inbox access." }
const smtpHostPlaceholder = { id: "settings.email.smtp.host.placeholder", message: "smtp.example.com" }
const smtpPortPlaceholder = { id: "settings.email.smtp.port.placeholder", message: "465" }
const smtpUserPlaceholder = { id: "settings.email.smtp.user.placeholder", message: "agent@example.com" }
const fromAddrPlaceholder = { id: "settings.email.smtp.fromAddr.placeholder", message: "agent@example.com" }
const fromNamePlaceholder = { id: "settings.email.smtp.fromName.placeholder", message: "Synergy" }
const imapHostPlaceholder = { id: "settings.email.imap.host.placeholder", message: "imap.example.com" }
const imapPortPlaceholder = { id: "settings.email.imap.port.placeholder", message: "993" }
const imapUserPlaceholder = { id: "settings.email.imap.user.placeholder", message: "agent@example.com" }

export function EmailPanel(props: {
  email: EmailSettings
  onEmailChange: (key: keyof EmailSettings, value: string | boolean) => void
}) {
  const { _ } = useLingui()
  const { email, onEmailChange } = props

  return (
    <SettingsPage title={_(pageTitle)} description={_(pageDesc)}>
      <SettingsSection title={_(mailToolsSection)}>
        <SettingRow
          title={_(mailToolsRowTitle)}
          description={_(mailToolsRowDesc)}
          stateLabel={email.enabled ? _(enabledLabel) : _(pausedLabel)}
          trailing={
            <Switch checked={email.enabled} hideLabel onChange={(v) => onEmailChange("enabled", v)}>
              {_(mailToolsRowTitle)}
            </Switch>
          }
        />
      </SettingsSection>

      <SettingsSection title={_(sendingSection)} description={_(sendingSectionDesc)}>
        <SettingsSubsection title={_(smtpSubTitle)} description={_(smtpSubDesc)}>
          <SettingRow
            title={_(smtpHostTitle)}
            description={_(smtpHostDesc)}
            trailing={
              <TextField
                type="text"
                placeholder={_(smtpHostPlaceholder)}
                value={email.smtpHost}
                onChange={(v) => onEmailChange("smtpHost", v)}
              />
            }
          />
          <SettingRow
            title={_(smtpPortTitle)}
            description={_(smtpPortDesc)}
            trailing={
              <TextField
                type="number"
                placeholder={_(smtpPortPlaceholder)}
                value={email.smtpPort}
                onChange={(v) => onEmailChange("smtpPort", v)}
              />
            }
          />
          <SettingRow
            title={_(smtpUserTitle)}
            description={_(smtpUserDesc)}
            trailing={
              <TextField
                type="text"
                placeholder={_(smtpUserPlaceholder)}
                value={email.smtpUsername}
                onChange={(v) => onEmailChange("smtpUsername", v)}
              />
            }
          />
          <SettingRow
            title={_(smtpPassTitle)}
            description={_(smtpPassDesc)}
            trailing={
              <PasswordField
                label={_(smtpPassTitle)}
                value={email.smtpPassword}
                onChange={(v) => onEmailChange("smtpPassword", v)}
              />
            }
          />
          <SettingRow
            title={_(fromAddrTitle)}
            description={_(fromAddrDesc)}
            trailing={
              <TextField
                type="text"
                placeholder={_(fromAddrPlaceholder)}
                value={email.fromAddress}
                onChange={(v) => onEmailChange("fromAddress", v)}
              />
            }
          />
          <SettingRow
            title={_(fromNameTitle)}
            description={_(fromNameDesc)}
            trailing={
              <TextField
                type="text"
                placeholder={_(fromNamePlaceholder)}
                value={email.fromName}
                onChange={(v) => onEmailChange("fromName", v)}
              />
            }
          />
          <SettingRow
            title={_(encSmtpTitle)}
            description={_(encSmtpDesc)}
            stateLabel={email.smtpSecure ? _(onLabel) : _(offLabel)}
            trailing={
              <Switch checked={email.smtpSecure} hideLabel onChange={(v) => onEmailChange("smtpSecure", v)}>
                {_(encSmtpTitle)}
              </Switch>
            }
          />
        </SettingsSubsection>
      </SettingsSection>

      <SettingsSection title={_(readingSection)} description={_(readingSectionDesc)}>
        <SettingsSubsection title={_(imapSubTitle)} description={_(imapSubDesc)}>
          <SettingRow
            title={_(imapHostTitle)}
            description={_(imapHostDesc)}
            trailing={
              <TextField
                type="text"
                placeholder={_(imapHostPlaceholder)}
                value={email.imapHost}
                onChange={(v) => onEmailChange("imapHost", v)}
              />
            }
          />
          <SettingRow
            title={_(imapPortTitle)}
            description={_(imapPortDesc)}
            trailing={
              <TextField
                type="number"
                placeholder={_(imapPortPlaceholder)}
                value={email.imapPort}
                onChange={(v) => onEmailChange("imapPort", v)}
              />
            }
          />
          <SettingRow
            title={_(imapUserTitle)}
            description={_(imapUserDesc)}
            trailing={
              <TextField
                type="text"
                placeholder={_(imapUserPlaceholder)}
                value={email.imapUsername}
                onChange={(v) => onEmailChange("imapUsername", v)}
              />
            }
          />
          <SettingRow
            title={_(imapPassTitle)}
            description={_(imapPassDesc)}
            trailing={
              <PasswordField
                label={_(imapPassTitle)}
                value={email.imapPassword}
                onChange={(v) => onEmailChange("imapPassword", v)}
              />
            }
          />
          <SettingRow
            title={_(encImapTitle)}
            description={_(encImapDesc)}
            stateLabel={email.imapSecure ? _(onLabel) : _(offLabel)}
            trailing={
              <Switch checked={email.imapSecure} hideLabel onChange={(v) => onEmailChange("imapSecure", v)}>
                {_(encImapTitle)}
              </Switch>
            }
          />
        </SettingsSubsection>
      </SettingsSection>
    </SettingsPage>
  )
}
