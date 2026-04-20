import { Global } from "../../global"
import { InspireCrypto } from "./crypto"
import { InspireTypes } from "./types"
import { Log } from "../../util/log"
import fs from "fs/promises"
import path from "path"

export namespace InspireAuth {
  const log = Log.create({ service: "inspire.auth" })

  let cachedCookie: { value: string; obtainedAt: number } | undefined
  let cachedToken: string | undefined

  export function notAuthenticatedError(target: "inspire" | "harbor"): InspireTypes.ToolResult {
    if (target === "inspire") {
      return {
        title: "未认证",
        output: [
          "启智平台账号未配置。",
          "",
          "请运行以下命令登录：",
          "  synergy sii inspire login",
          "",
          "或提供学工号和密码，我可以通过 bash 帮你执行登录命令。",
        ].join("\n"),
        metadata: { error: "inspire_not_authenticated" },
      }
    }
    return {
      title: "未认证",
      output: [
        "Harbor 镜像仓库账号未配置。",
        "",
        "请运行以下命令登录：",
        "  synergy sii harbor login",
        "",
        "Harbor 的用户名和密码可在启智平台「镜像管理 → 本地推送」页面查看。",
        "首次打开该页面时会显示用户名和密码，请妥善保存。",
      ].join("\n"),
      metadata: { error: "harbor_not_authenticated" },
    }
  }

  async function ensureDir(filepath: string) {
    await fs.mkdir(path.dirname(filepath), { recursive: true })
  }

  export async function getInspireCredentials(): Promise<InspireTypes.InspireAuth | undefined> {
    try {
      const file = Bun.file(Global.Path.authInspire)
      if (!(await file.exists())) return undefined
      return await file.json()
    } catch {
      return undefined
    }
  }

  export async function saveInspireCredentials(username: string, password: string): Promise<void> {
    const data: InspireTypes.InspireAuth = { username, password, saved_at: Date.now() }
    await ensureDir(Global.Path.authInspire)
    await Bun.write(Global.Path.authInspire, JSON.stringify(data, null, 2))
  }

  export async function getHarborCredentials(): Promise<InspireTypes.HarborAuth | undefined> {
    try {
      const file = Bun.file(Global.Path.authHarbor)
      if (!(await file.exists())) return undefined
      return await file.json()
    } catch {
      return undefined
    }
  }

  export async function saveHarborCredentials(username: string, password: string): Promise<void> {
    const data: InspireTypes.HarborAuth = {
      username,
      password,
      registry: InspireTypes.HARBOR_REGISTRY,
      saved_at: Date.now(),
    }
    await ensureDir(Global.Path.authHarbor)
    await Bun.write(Global.Path.authHarbor, JSON.stringify(data, null, 2))
  }

  export async function requireToken(): Promise<string> {
    if (cachedToken) return cachedToken

    const tokenFile = Global.Path.cacheInspireToken
    try {
      const file = Bun.file(tokenFile)
      if (await file.exists()) {
        const cache: InspireTypes.TokenCache = await file.json()
        if (cache.expires_at > Date.now()) {
          cachedToken = cache.token
          return cache.token
        }
      }
    } catch {}

    const creds = await getInspireCredentials()
    if (!creds) throw new Error("inspire_not_authenticated")

    const resp = await fetch(`${InspireTypes.PLATFORM_URL}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: creds.username, password: creds.password }),
    })
    const data = (await resp.json()) as any
    if (data.code !== 0) {
      log.warn("token auth failed, will rely on CAS cookie", { message: data.message })
      throw new Error(`Token auth failed: ${data.message ?? "unknown error"}`)
    }

    const tokenData = data.data ?? data
    const token = tokenData.access_token as string
    const expiresIn = parseInt(tokenData.expires_in ?? "604800", 10)

    cachedToken = token
    await ensureDir(tokenFile)
    await Bun.write(tokenFile, JSON.stringify({ token, expires_at: Date.now() + expiresIn * 1000 }))
    return token
  }

  export function clearToken(): void {
    cachedToken = undefined
  }

  export async function requireCookie(): Promise<string> {
    if (cachedCookie) return cachedCookie.value

    const cookie = await performCasLogin()
    cachedCookie = { value: cookie, obtainedAt: Date.now() }
    return cookie
  }

  export function clearCookie(): void {
    cachedCookie = undefined
  }

  export async function withTokenRetry<T>(fn: (token: string) => Promise<T>): Promise<T> {
    let token: string
    try {
      token = await requireToken()
    } catch {
      token = await requireTokenViaCas()
    }

    try {
      return await fn(token)
    } catch (err: any) {
      if (isAuthError(err)) {
        clearToken()
        try {
          token = await requireToken()
        } catch {
          token = await requireTokenViaCas()
        }
        return await fn(token)
      }
      throw err
    }
  }

  export async function withCookieRetry<T>(fn: (cookie: string) => Promise<T>): Promise<T> {
    const cookie = await requireCookie()
    try {
      return await fn(cookie)
    } catch (err: any) {
      if (isAuthError(err)) {
        clearCookie()
        const freshCookie = await requireCookie()
        return await fn(freshCookie)
      }
      throw err
    }
  }

  function isAuthError(err: any): boolean {
    if (err?.status === 401) return true
    if (err?.code === -1) return true
    const msg = String(err?.message ?? err ?? "").toLowerCase()
    return msg.includes("401") || msg.includes("unauthorized") || msg.includes("cookie") || msg.includes("token")
  }

  async function requireTokenViaCas(): Promise<string> {
    const cookie = await requireCookie()
    return `cookie:${cookie}`
  }

  async function performCasLogin(): Promise<string> {
    const creds = await getInspireCredentials()
    if (!creds) throw new Error("inspire_not_authenticated")

    log.info("performing CAS login", { username: creds.username })

    const session = {
      cookies: new Map<string, Map<string, string>>(),
      addCookies(domain: string, setCookieHeaders: string[]) {
        if (!this.cookies.has(domain)) this.cookies.set(domain, new Map())
        const jar = this.cookies.get(domain)!
        for (const header of setCookieHeaders) {
          const [pair] = header.split(";")
          const eqIdx = pair.indexOf("=")
          if (eqIdx > 0) {
            jar.set(pair.slice(0, eqIdx).trim(), pair.slice(eqIdx + 1).trim())
          }
        }
      },
      getCookieString(domain: string): string {
        const entries: string[] = []
        for (const [d, jar] of this.cookies) {
          if (domain.includes(d) || d.includes(domain)) {
            for (const [k, v] of jar) entries.push(`${k}=${v}`)
          }
        }
        return entries.join("; ")
      },
    }

    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"

    let currentUrl = InspireTypes.PLATFORM_URL
    let html = ""

    for (let i = 0; i < 10; i++) {
      const resp = await fetch(currentUrl, {
        headers: {
          "User-Agent": ua,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Cookie: session.getCookieString(new URL(currentUrl).hostname),
        },
        redirect: "manual",
      })

      const setCookies = resp.headers.getSetCookie?.() ?? []
      session.addCookies(new URL(currentUrl).hostname, setCookies)

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location")
        if (!location) break
        currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).toString()
        continue
      }

      html = await resp.text()
      break
    }

    const hostname = new URL(currentUrl).hostname
    if (hostname === "qz.sii.edu.cn") {
      const cookieStr = session.getCookieString("qz.sii.edu.cn")
      if (cookieStr.includes("session")) return cookieStr
    }

    if (currentUrl.includes("keycloak")) {
      const casMatch = html.match(/"loginUrl":\s*"([^"]*broker\/cas\/login[^"]*)"/)
      if (!casMatch) throw new Error("Keycloak 页面中未找到 CAS 登录链接")
      let casUrl = casMatch[1].replace(/\\\//g, "/")
      if (!casUrl.startsWith("http")) {
        const parsed = new URL(currentUrl)
        casUrl = `${parsed.protocol}//${parsed.host}${casUrl}`
      }

      currentUrl = casUrl
      for (let i = 0; i < 10; i++) {
        const resp = await fetch(currentUrl, {
          headers: {
            "User-Agent": ua,
            Cookie: session.getCookieString(new URL(currentUrl).hostname),
          },
          redirect: "manual",
        })
        const setCookies = resp.headers.getSetCookie?.() ?? []
        session.addCookies(new URL(currentUrl).hostname, setCookies)

        if (resp.status >= 300 && resp.status < 400) {
          const location = resp.headers.get("location")
          if (!location) break
          currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).toString()
          continue
        }
        html = await resp.text()
        break
      }
    }

    if (!currentUrl.includes("cas.sii.edu.cn")) {
      throw new Error(`未能到达 CAS 登录页面，当前 URL: ${currentUrl}`)
    }

    const encrypted = InspireCrypto.encryptPassword(creds.password)
    const ltMatch = html.match(/name="lt"\s+value="([^"]+)"/)
    const execMatch = html.match(/name="execution"\s+value="([^"]+)"/)

    const formData = new URLSearchParams()
    formData.set("username", creds.username)
    formData.set("password", encrypted)
    formData.set("_eventId", "submit")
    formData.set("submit", "登 录")
    formData.set("loginType", "1")
    formData.set("encrypted", "true")
    if (ltMatch) formData.set("lt", ltMatch[1])
    if (execMatch) formData.set("execution", execMatch[1])

    currentUrl = currentUrl
    for (let i = 0; i < 15; i++) {
      const isPost = i === 0
      const resp = await fetch(currentUrl, {
        method: isPost ? "POST" : "GET",
        headers: {
          "User-Agent": ua,
          ...(isPost
            ? {
                "Content-Type": "application/x-www-form-urlencoded",
                Origin: "https://cas.sii.edu.cn",
                Referer: currentUrl,
              }
            : {}),
          Cookie: session.getCookieString(new URL(currentUrl).hostname),
        },
        ...(isPost ? { body: formData.toString() } : {}),
        redirect: "manual",
      })

      const setCookies = resp.headers.getSetCookie?.() ?? []
      session.addCookies(new URL(currentUrl).hostname, setCookies)

      if (resp.status >= 300 && resp.status < 400) {
        const location = resp.headers.get("location")
        if (!location) break
        currentUrl = location.startsWith("http") ? location : new URL(location, currentUrl).toString()
        continue
      }

      html = await resp.text()

      if (new URL(currentUrl).hostname === "qz.sii.edu.cn") break

      if (currentUrl.includes("cas.sii.edu.cn") && currentUrl.includes("login")) {
        if (html.includes("用户名或密码错误") || html.includes("账号或密码错误")) {
          throw new Error("用户名或密码错误")
        }
        if (html.includes("验证码")) {
          throw new Error("需要输入验证码，请在浏览器中登录后手动获取 cookie")
        }
        throw new Error("登录失败，请检查用户名和密码")
      }

      break
    }

    if (new URL(currentUrl).hostname !== "qz.sii.edu.cn") {
      const resp = await fetch(InspireTypes.PLATFORM_URL, {
        headers: { "User-Agent": ua, Cookie: session.getCookieString("qz.sii.edu.cn") },
        redirect: "manual",
      })
      const setCookies = resp.headers.getSetCookie?.() ?? []
      session.addCookies("qz.sii.edu.cn", setCookies)
    }

    const cookieStr = session.getCookieString("qz.sii.edu.cn")
    if (!cookieStr.includes("session")) {
      throw new Error("登录成功但未获取到 session cookie")
    }

    log.info("CAS login successful")
    return cookieStr
  }

  export async function testInspireConnection(): Promise<boolean> {
    try {
      await requireCookie()
      return true
    } catch {
      return false
    }
  }

  export async function testHarborConnection(): Promise<boolean> {
    const creds = await getHarborCredentials()
    if (!creds) return false
    try {
      const resp = await fetch(`https://${InspireTypes.HARBOR_REGISTRY}/api/v2.0/projects?page_size=1`, {
        headers: { Authorization: "Basic " + btoa(`${creds.username}:${creds.password}`) },
      })
      return resp.ok
    } catch {
      return false
    }
  }
}
