import AppKit
import Foundation

private struct CLIEnvelope<Payload: Decodable>: Decodable {
  let ok: Bool
  let data: Payload?
}

private struct StatusPayload: Decodable {
  let auth: AuthPayload
  let state: StatePayload
  let session: SessionPayload?
  let envID: String?
  let service: ServicePayload
}

private struct AuthPayload: Decodable {
  let loggedIn: Bool
  let agentID: String?
}

private struct StatePayload: Decodable {
  let collaborationEnabled: Bool
  let connectionStatus: String
  let currentSession: SessionPayload?
  let envID: String?
}

private struct SessionPayload: Decodable {
  let sessionID: String?
  let remoteAgentID: String?
}

private struct ServicePayload: Decodable {
  let running: Bool
  let runtimeStatus: String
  let pid: Int?
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private var statusItem: NSStatusItem!
  private var menu: NSMenu!
  private var pollTimer: Timer?
  private var statusImage: NSImage?
  private var lastStatus: StatusPayload?

  private let agentItem = NSMenuItem(title: "Agent ID: unknown", action: #selector(copyAgentID), keyEquivalent: "")
  private let envItem = NSMenuItem(title: "Env ID: unknown", action: #selector(copyEnvID), keyEquivalent: "")
  private let loginItem = NSMenuItem(title: "Login with Holos", action: #selector(login), keyEquivalent: "")
  private let connectionItem = NSMenuItem(title: "Holos: disconnected", action: #selector(reconnect), keyEquivalent: "")
  private let collaborationItem = NSMenuItem(title: "Collaboration: on", action: #selector(toggleCollaboration), keyEquivalent: "")
  private let terminateItem = NSMenuItem(title: "Terminate Collaboration", action: #selector(terminateCollaboration), keyEquivalent: "")
  private let refreshItem = NSMenuItem(title: "Refresh", action: #selector(refreshStatus), keyEquivalent: "r")
  private let quitItem = NSMenuItem(title: "Quit", action: #selector(quitApp), keyEquivalent: "q")

  private var currentAgentID: String?
  private var currentEnvID: String?

  private lazy var runtimeURL: URL? = {
    Bundle.main.resourceURL?.appendingPathComponent("meta-synergy-runtime")
  }()

  func applicationDidFinishLaunching(_ notification: Notification) {
    statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    statusImage = loadStatusImage()
    applyStatusAppearance(textFallback: "Meta", toolTip: "MetaSynergy")

    menu = NSMenu()

    agentItem.target = self
    envItem.target = self
    loginItem.target = self
    connectionItem.target = self
    collaborationItem.target = self
    terminateItem.target = self
    refreshItem.target = self
    quitItem.target = self

    configureCopyIcon(for: agentItem)
    configureCopyIcon(for: envItem)

    menu.addItem(agentItem)
    menu.addItem(envItem)
    menu.addItem(loginItem)
    menu.addItem(.separator())
    menu.addItem(connectionItem)
    menu.addItem(collaborationItem)
    menu.addItem(terminateItem)
    menu.addItem(refreshItem)
    menu.addItem(.separator())
    menu.addItem(quitItem)

    statusItem.menu = menu

    startServiceIfPossible()
    refreshStatus()

    pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.refreshStatus()
    }
  }

  @objc private func login() {
    _ = runCommand(["login"])
    startServiceIfPossible()
    refreshStatus()
  }

  @objc private func reconnect() {
    let status = lastStatus ?? loadStatus()
    let serviceRunning = status?.service.running ?? false
    if serviceRunning {
      _ = runCommand(["reconnect"])
    } else {
      startServiceIfPossible()
    }
    refreshStatus()
  }

  @objc private func refreshStatus() {
    guard let status = loadStatus() else {
      lastStatus = nil
      currentAgentID = nil
      currentEnvID = nil
      agentItem.isHidden = true
      envItem.isHidden = true
      loginItem.isHidden = false
      connectionItem.isHidden = false
      connectionItem.title = "Holos: unavailable"
      connectionItem.isEnabled = false
      collaborationItem.isHidden = true
      terminateItem.isHidden = true
      refreshItem.isHidden = false
      applyStatusAppearance(textFallback: "Meta", toolTip: "MetaSynergy")
      return
    }

    lastStatus = status

    let loggedIn = status.auth.loggedIn
    let agentID = status.auth.agentID
    let envID = status.envID ?? status.state.envID
    let connectionStatus = status.state.connectionStatus
    let collaborationEnabled = status.state.collaborationEnabled
    let session = status.session ?? status.state.currentSession
    let serviceRunning = status.service.running
    let serviceTransitioning = status.service.runtimeStatus == "starting" || status.service.runtimeStatus == "stopping"

    currentAgentID = loggedIn ? agentID : nil
    currentEnvID = loggedIn ? envID : nil

    agentItem.isHidden = !loggedIn
    envItem.isHidden = !loggedIn
    loginItem.isHidden = loggedIn

    if loggedIn {
      agentItem.title = "Agent ID: \(truncateID(agentID))"
      envItem.title = "Env ID: \(truncateID(envID))"
    }

    connectionItem.isHidden = !loggedIn
    collaborationItem.isHidden = !loggedIn
    terminateItem.isHidden = !loggedIn
    refreshItem.isHidden = false

    let connectionSummary = serviceRunning ? connectionStatus : "service \(status.service.runtimeStatus)"
    connectionItem.title = "Holos: \(connectionSummary)"
    connectionItem.isEnabled = loggedIn && !serviceTransitioning && (!serviceRunning || connectionStatus != "connected")

    collaborationItem.title = collaborationEnabled ? "Collaboration: on" : "Collaboration: off"
    collaborationItem.isEnabled = loggedIn

    if let sessionID = session?.sessionID,
       let remoteAgentID = session?.remoteAgentID {
      terminateItem.title = "Terminate Collaboration (\(truncateID(remoteAgentID)), \(sessionID.prefix(8)))"
      terminateItem.isEnabled = true
      applyStatusAppearance(textFallback: "Meta Busy", toolTip: "MetaSynergy: busy")
    } else {
      terminateItem.title = "Terminate Collaboration"
      terminateItem.isEnabled = false

      if !loggedIn {
        applyStatusAppearance(textFallback: "Meta", toolTip: "MetaSynergy")
      } else if !serviceRunning {
        applyStatusAppearance(textFallback: "Meta", toolTip: "MetaSynergy: service \(status.service.runtimeStatus)")
      } else {
        applyStatusAppearance(
          textFallback: collaborationEnabled ? "Meta" : "Meta Off",
          toolTip: collaborationEnabled
            ? "MetaSynergy: Holos \(connectionStatus)"
            : "MetaSynergy: collaboration off"
        )
      }
    }
  }

  @objc private func toggleCollaboration() {
    let enabled = lastStatus?.state.collaborationEnabled ?? loadStatus()?.state.collaborationEnabled
    guard let enabled else {
      return
    }

    _ = runCommand(["collaboration", enabled ? "disable" : "enable"])
    refreshStatus()
  }

  @objc private func terminateCollaboration() {
    _ = runCommand(["session", "kick"])
    refreshStatus()
  }

  @objc private func copyAgentID() {
    copyValue(currentAgentID)
  }

  @objc private func copyEnvID() {
    copyValue(currentEnvID)
  }

  @objc private func quitApp() {
    _ = runCommand(["stop"])
    NSApplication.shared.terminate(nil)
  }

  private func startServiceIfPossible() {
    guard hasAuth() else { return }
    let status = lastStatus ?? loadStatus()
    if status?.service.running == true {
      return
    }
    _ = runCommand(["start"])
  }

  private func hasAuth() -> Bool {
    (lastStatus ?? loadStatus())?.auth.loggedIn == true
  }

  @discardableResult
  private func runCommand(_ args: [String]) -> String? {
    guard let runtimeURL else { return nil }
    let process = Process()
    process.executableURL = runtimeURL
    process.arguments = args

    let output = Pipe()
    process.standardOutput = output
    process.standardError = output

    do {
      try process.run()
      process.waitUntilExit()
      let data = output.fileHandleForReading.readDataToEndOfFile()
      return String(data: data, encoding: .utf8)
    } catch {
      return nil
    }
  }

  private func loadStatus() -> StatusPayload? {
    runJSONCommand(["status"], as: StatusPayload.self)
  }

  private func runJSONCommand<Payload: Decodable>(_ args: [String], as type: Payload.Type) -> Payload? {
    guard let output = runCommand(args + ["--json"]),
          let data = output.data(using: .utf8),
          let envelope = try? JSONDecoder().decode(CLIEnvelope<Payload>.self, from: data),
          envelope.ok,
          let payload = envelope.data
    else {
      return nil
    }

    return payload
  }

  private func copyValue(_ value: String?) {
    guard let value, !value.isEmpty else { return }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(value, forType: .string)
  }

  private func configureCopyIcon(for item: NSMenuItem) {
    guard let image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy") else {
      return
    }
    image.isTemplate = true
    item.image = image
  }

  private func truncateID(_ value: String?) -> String {
    guard let value else { return "unknown" }
    if value.count <= 18 {
      return value
    }

    return "\(value.prefix(8))...\(value.suffix(6))"
  }

  private func loadStatusImage() -> NSImage? {
    guard let url = Bundle.main.resourceURL?.appendingPathComponent("StatusIcon.png"),
          let source = NSImage(contentsOf: url)
    else {
      return nil
    }

    let canvasSize = NSSize(width: 18, height: 18)
    let image = NSImage(size: canvasSize)
    image.lockFocus()
    NSColor.clear.setFill()
    NSBezierPath(rect: NSRect(origin: .zero, size: canvasSize)).fill()

    let targetRect = fitRect(
      sourceSize: source.size,
      into: NSRect(x: 1.75, y: 1.75, width: 14.5, height: 14.5),
    )
    source.draw(in: targetRect)

    image.unlockFocus()
    image.isTemplate = true
    return image
  }

  private func applyStatusAppearance(textFallback: String, toolTip: String) {
    guard let button = statusItem.button else { return }
    if let statusImage {
      button.image = statusImage
      button.imagePosition = .imageOnly
      button.title = ""
    } else {
      button.image = nil
      button.title = textFallback
    }
    button.toolTip = toolTip
  }

  private func fitRect(sourceSize: NSSize, into rect: NSRect) -> NSRect {
    guard sourceSize.width > 0, sourceSize.height > 0 else { return rect }
    let scale = min(rect.width / sourceSize.width, rect.height / sourceSize.height)
    let width = sourceSize.width * scale
    let height = sourceSize.height * scale
    return NSRect(
      x: rect.midX - width / 2,
      y: rect.midY - height / 2,
      width: width,
      height: height,
    )
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
