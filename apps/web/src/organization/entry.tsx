import { render } from "solid-js/web"
import { MetaProvider } from "@solidjs/meta"
import { Font } from "@ericsanchezok/synergy-ui/font"
import { ThemeProvider } from "@ericsanchezok/synergy-ui/theme"
import { LocaleProvider } from "@/context/locale"
import { consumeAuthorizationLocation, type AuthorizationPage } from "./authorization"
import { OrganizationAuthorizationPage } from "./page"
import "@ericsanchezok/synergy-ui/styles"

const page = (() => {
  try {
    return consumeAuthorizationLocation(window.location, window.history)
  } catch {
    return undefined
  }
})()

export function OrganizationAuthorizationApp(props: { page?: AuthorizationPage }) {
  return (
    <MetaProvider>
      <Font />
      <LocaleProvider>
        <ThemeProvider>
          <OrganizationAuthorizationPage page={props.page} />
        </ThemeProvider>
      </LocaleProvider>
    </MetaProvider>
  )
}

render(() => <OrganizationAuthorizationApp page={page} />, document.getElementById("root")!)
