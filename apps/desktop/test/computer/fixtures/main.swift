import AppKit

// Provenance: https://github.com/trycua/cua/tree/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver/apps/macos/appkit
// Local adaptation: independent state oracle, two exact windows and a canvas-only random code.
final class Canvas: NSView {
    let nonce = String(UUID().uuidString.prefix(8))
    var hits = 0
    var changed: (() -> Void)?
    let target = NSRect(x: 260, y: 70, width: 80, height: 80)
    override var isFlipped: Bool { true }
    override func isAccessibilityElement() -> Bool { false }
    override func accessibilityChildren() -> [Any]? { [] }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        ("Canvas code: " + nonce as NSString).draw(at: NSPoint(x: 18, y: 20), withAttributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 25, weight: .bold), .foregroundColor: NSColor.black,
        ])
        NSColor.systemBlue.setFill()
        NSBezierPath(ovalIn: target).fill()
        ("CLICK" as NSString).draw(at: NSPoint(x: 275, y: 100), withAttributes: [
            .font: NSFont.systemFont(ofSize: 15, weight: .bold), .foregroundColor: NSColor.white,
        ])
    }
    override func mouseDown(with event: NSEvent) {
        if target.contains(convert(event.locationInWindow, from: nil)) { hits += 1; changed?() }
    }
}

final class FixtureWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let canvas: Canvas
    let token = "AX-" + String(UUID().uuidString.prefix(8))
    var clicks = 0
    var changed: (() -> Void)?
    init(_ name: String, x: CGFloat) {
        window = NSWindow(contentRect: NSRect(x: x, y: 140, width: 540, height: 300), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        canvas = Canvas(frame: NSRect(x: 20, y: 25, width: 490, height: 160))
        super.init()
        window.title = "Synergy Computer Fixture " + name
        window.isReleasedWhenClosed = false
        window.delegate = self
        let label = NSTextField(labelWithString: token)
        label.frame = NSRect(x: 20, y: 230, width: 400, height: 28)
        window.contentView!.addSubview(label)
        let button = NSButton(title: "Increment", target: self, action: #selector(increment))
        button.frame = NSRect(x: 20, y: 190, width: 120, height: 32)
        window.contentView!.addSubview(button)
        window.contentView!.addSubview(canvas)
        canvas.changed = { [weak self] in self?.changed?() }
    }
    @objc func increment() { clicks += 1; changed?() }
    func windowDidResize(_ notification: Notification) { changed?() }
    func windowDidMove(_ notification: Notification) { changed?() }
    func report() -> [String: Any] {
        let frame = window.frame
        let target = canvas.convert(canvas.target, to: nil)
        let screenTarget = window.convertToScreen(target)
        return ["windowId": window.windowNumber, "title": window.title, "axToken": token, "nonce": canvas.nonce,
                "clicks": clicks, "hits": canvas.hits, "visible": window.isVisible,
                "width": frame.width, "height": frame.height,
                "targetX": screenTarget.midX - frame.minX, "targetY": frame.maxY - screenTarget.midY]
    }
}

final class App: NSObject, NSApplicationDelegate {
    let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SYNERGY_COMPUTER_FIXTURE_DIR"]!)
    var windows: [FixtureWindow] = []
    var lastCommand = ""
    let priorFrontmost = NSWorkspace.shared.frontmostApplication
    func applicationDidFinishLaunching(_ notification: Notification) {
        windows = [FixtureWindow("A", x: 80), FixtureWindow("B", x: 650)]
        for fixture in windows {
            fixture.changed = { [weak self] in self?.save() }
            fixture.window.orderFront(nil)
        }
        windows[0].window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        save()
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.command() }
    }
    func save() {
        let value: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "windows": windows.map { $0.report() }, "command": lastCommand,
                                  "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
                                  "displays": NSScreen.screens.map { ["scale": $0.backingScaleFactor, "width": $0.frame.width, "height": $0.frame.height] }]
        if let data = try? JSONSerialization.data(withJSONObject: value) { try? data.write(to: root.appendingPathComponent("oracle.json"), options: .atomic) }
    }
    func command() {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("command.json")),
              let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = command["id"] as? String, id != lastCommand else { return }
        lastCommand = id
        let fixture = windows[command["index"] as? Int ?? 0]
        switch command["type"] as? String {
        case "resize": fixture.window.setContentSize(NSSize(width: command["width"] as? Double ?? 480, height: 300))
        case "move": fixture.window.setFrameOrigin(NSPoint(x: command["x"] as? Double ?? 100, y: command["y"] as? Double ?? 120))
        case "hide": fixture.window.orderOut(nil)
        case "show": fixture.window.orderFront(nil)
        case "background": priorFrontmost?.activate(options: [])
        case "close": fixture.window.close()
        case "refresh": break
        case "quit": NSApp.terminate(nil)
        default: break
        }
        save()
    }
}

let app = NSApplication.shared
let delegate = App()
app.setActivationPolicy(.regular)
app.delegate = delegate
app.run()
