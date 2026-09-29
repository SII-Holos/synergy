import AppKit

// Provenance: https://github.com/trycua/cua/tree/bf6c76786d938070f4ecf1e44004752f69f518b8/libs/cua-driver/apps/macos/appkit
// Local adaptation: independent state oracle, two exact windows and a canvas-only random code.
final class Canvas: NSView {
    let nonce = String(UUID().uuidString.prefix(8))
    var hits = 0
    var doubleClicks = 0
    var rightClicks = 0
    var drags = 0
    var keys = 0
    var shortcuts = 0
    var dragging = false
    override var acceptsFirstResponder: Bool { true }
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
        window?.makeFirstResponder(self)
        if target.contains(convert(event.locationInWindow, from: nil)) {
            hits += 1
            if event.clickCount == 2 { doubleClicks += 1 }
            needsDisplay = true
            changed?()
        }
    }
    override func rightMouseDown(with event: NSEvent) { rightClicks += 1; changed?() }
    override func mouseDragged(with event: NSEvent) { dragging = true }
    override func mouseUp(with event: NSEvent) {
        if dragging { drags += 1; dragging = false; changed?() }
    }
    override func keyDown(with event: NSEvent) { keys += 1; changed?() }
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == "k" {
            shortcuts += 1; changed?(); return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

final class FixtureWindow: NSObject, NSWindowDelegate, NSTextFieldDelegate {
    let window: NSWindow
    let canvas: Canvas
    let field = NSTextField(string: "")
    let slider = NSSlider(value: 10, minValue: 0, maxValue: 100, target: nil, action: nil)
    let scroll = NSScrollView()
    let token = "AX-" + String(UUID().uuidString.prefix(8))
    var clicks = 0
    var changed: (() -> Void)?
    init(_ name: String, x: CGFloat) {
        window = NSWindow(contentRect: NSRect(x: x, y: 140, width: 540, height: 480), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        canvas = Canvas(frame: NSRect(x: 20, y: 25, width: 490, height: 160))
        super.init()
        window.title = "Synergy Computer Fixture " + name
        window.isReleasedWhenClosed = false
        window.delegate = self
        let label = NSTextField(labelWithString: token)
        label.frame = NSRect(x: 20, y: 430, width: 400, height: 28)
        window.contentView!.addSubview(label)
        let button = NSButton(title: "Increment", target: self, action: #selector(increment))
        button.frame = NSRect(x: 20, y: 390, width: 120, height: 32)
        window.contentView!.addSubview(button)
        field.frame = NSRect(x: 20, y: 340, width: 250, height: 30)
        field.setAccessibilityLabel("Name")
        field.delegate = self
        window.contentView!.addSubview(field)
        slider.frame = NSRect(x: 20, y: 295, width: 250, height: 24)
        slider.setAccessibilityLabel("Level")
        window.contentView!.addSubview(slider)
        scroll.frame = NSRect(x: 320, y: 240, width: 180, height: 160)
        scroll.hasVerticalScroller = true
        scroll.setAccessibilityLabel("Rows")
        let document = NSTextView(frame: NSRect(x: 0, y: 0, width: 160, height: 1400))
        document.isEditable = false
        document.string = (1...60).map { "Row \($0)" }.joined(separator: "\n")
        scroll.documentView = document
        scroll.contentView.scroll(to: .zero)
        window.contentView!.addSubview(scroll)
        window.contentView!.addSubview(canvas)
        window.initialFirstResponder = canvas
        canvas.changed = { [weak self] in self?.changed?() }
    }
    @objc func increment() { clicks += 1; changed?() }
    func controlTextDidChange(_ notification: Notification) { changed?() }
    func windowDidResize(_ notification: Notification) { changed?() }
    func windowDidMove(_ notification: Notification) { changed?() }
    func report() -> [String: Any] {
        let frame = window.frame
        let target = canvas.convert(canvas.target, to: nil)
        let screenTarget = window.convertToScreen(target)
        return ["windowId": window.windowNumber, "title": window.title, "axToken": token, "nonce": canvas.nonce,
                "clicks": clicks, "hits": canvas.hits, "text": field.stringValue, "value": slider.doubleValue,
                "scrollY": scroll.contentView.bounds.origin.y, "doubleClicks": canvas.doubleClicks,
                "rightClicks": canvas.rightClicks, "drags": canvas.drags, "keys": canvas.keys, "shortcuts": canvas.shortcuts, "visible": window.isVisible, "onActiveSpace": window.isOnActiveSpace,
                "width": frame.width, "height": frame.height,
                "targetX": screenTarget.midX - frame.minX, "targetY": frame.maxY - screenTarget.midY]
    }
}

final class App: NSObject, NSApplicationDelegate {
    let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SYNERGY_COMPUTER_FIXTURE_DIR"]!)
    var windows: [FixtureWindow] = []
    var lastCommand = ""
    var activationCount = 0
    var spaceChangeCount = 0
    var frontmostHistory: [Int32] = []
    var observers: [NSObjectProtocol] = []
    func applicationDidFinishLaunching(_ notification: Notification) {
        let notifications = NSWorkspace.shared.notificationCenter
        observers.append(notifications.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self.recordFrontmost(app.processIdentifier)
            self.save()
        })
        observers.append(notifications.addObserver(forName: NSWorkspace.activeSpaceDidChangeNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            self.spaceChangeCount += 1
            self.save()
        })
        windows = [FixtureWindow("A", x: 80), FixtureWindow("B", x: 650)]
        for fixture in windows {
            fixture.changed = { [weak self] in self?.save() }
            fixture.window.orderBack(nil)
        }
        save()
        Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.command() }
    }
    func applicationDidBecomeActive(_ notification: Notification) {
        activationCount += 1
        save()
    }
    func recordFrontmost(_ pid: Int32) {
        if frontmostHistory.last != pid && frontmostHistory.count < 256 { frontmostHistory.append(pid) }
    }
    func save() {
        let frontmost = NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0
        recordFrontmost(frontmost)
        let value: [String: Any] = ["pid": ProcessInfo.processInfo.processIdentifier, "windows": windows.map { $0.report() }, "command": lastCommand,
                                  "frontmost": frontmost, "frontmostHistory": frontmostHistory, "activationCount": activationCount, "spaceChangeCount": spaceChangeCount,
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
        case "resize": fixture.window.setContentSize(NSSize(width: command["width"] as? Double ?? 480, height: 480))
        case "move": fixture.window.setFrameOrigin(NSPoint(x: command["x"] as? Double ?? 100, y: command["y"] as? Double ?? 120))
        case "hide": fixture.window.orderOut(nil)
        case "show": fixture.window.orderBack(nil)
        case "close": fixture.window.close()
        case "background":
            if let pid = command["pid"] as? Int32 { NSRunningApplication(processIdentifier: pid)?.activate(options: []) }
        case "cover":
            windows[1].window.setFrame(fixture.window.frame, display: true)
            windows[1].window.orderFront(nil)
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
