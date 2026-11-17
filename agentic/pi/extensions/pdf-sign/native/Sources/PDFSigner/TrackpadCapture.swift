import AppKit
import ApplicationServices

final class SigningApplication: NSApplication {
    weak var capture: TrackpadCapture?

    static func ignoresDuringCapture(_ type: NSEvent.EventType) -> Bool {
        switch type {
        case .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
             .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged,
             .rightMouseDragged, .otherMouseDragged, .pressure,
             .scrollWheel, .magnify, .smartMagnify, .rotate, .swipe, .quickLook:
            return true
        default:
            return false
        }
    }

    override func sendEvent(_ event: NSEvent) {
        if let capture {
            if Self.ignoresDuringCapture(event.type) { return }
            if event.type == .keyDown {
                capture.handleKey(event)
                return
            }
        }
        super.sendEvent(event)
    }
}

final class CapturePanel: NSPanel {
    weak var capture: TrackpadCapture?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }

    override func sendEvent(_ event: NSEvent) {
        if let capture {
            if event.type == .gesture { capture.consumeTouches(event) }
            if SigningApplication.ignoresDuringCapture(event.type) { return }
            if event.type == .keyDown {
                capture.handleKey(event)
                return
            }
        }
        super.sendEvent(event)
    }
}

final class TrackpadView: NSView {
    var recorder = StrokeRecorder()
    var deviceSize = CGSize(width: 160, height: 100)
    var onChange: (() -> Void)?
    private var activeIdentity: AnyHashable?

    override var acceptsFirstResponder: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        allowedTouchTypes = [.indirect]
        wantsRestingTouches = true
        focusRingType = .none
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    static func identity(_ touch: NSTouch) -> AnyHashable {
        (touch.identity as? AnyHashable) ?? AnyHashable(ObjectIdentifier(touch.identity as AnyObject))
    }

    private func point(_ touch: NSTouch) -> CGPoint {
        CGPoint(x: touch.normalizedPosition.x * deviceSize.width, y: touch.normalizedPosition.y * deviceSize.height)
    }

    func consume(_ event: NSEvent) {
        for touch in event.touches(matching: .began, in: nil) {
            if activeIdentity == nil {
                deviceSize = touch.deviceSize
                if deviceSize.width <= 0 || deviceSize.height <= 0 {
                    deviceSize = CGSize(width: 160, height: 100)
                }
                activeIdentity = Self.identity(touch)
            }
            recorder.begin(Self.identity(touch), at: point(touch))
        }
        for touch in event.touches(matching: .moved, in: nil) {
            recorder.move(Self.identity(touch), to: point(touch))
        }
        for touch in event.touches(matching: .ended, in: nil) {
            let identity = Self.identity(touch)
            recorder.end(identity, at: point(touch))
            if activeIdentity == identity { activeIdentity = nil }
        }
        for touch in event.touches(matching: .cancelled, in: nil) {
            let identity = Self.identity(touch)
            recorder.end(identity, at: nil)
            if activeIdentity == identity { activeIdentity = nil }
        }
        changed()
    }

    private func changed() {
        needsDisplay = true
        onChange?()
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        // Absolute mapping: every trackpad corner is the corresponding canvas corner.
        context.scaleBy(x: bounds.width / deviceSize.width, y: bounds.height / deviceSize.height)
        context.setStrokeColor(NSColor.black.cgColor)
        context.setFillColor(NSColor.black.cgColor)
        context.setLineWidth(0.6)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        for stroke in recorder.drawing.strokes {
            guard let first = stroke.first else { continue }
            if stroke.count == 1 {
                context.fillEllipse(in: CGRect(x: first.x - 0.3, y: first.y - 0.3, width: 0.6, height: 0.6))
            } else {
                context.beginPath()
                context.move(to: first)
                for point in stroke.dropFirst() { context.addLine(to: point) }
                context.strokePath()
            }
        }
        context.restoreGState()
    }
}

/// Owns pointer capture; every exit crosses the same idempotent restoration seam.
final class TrackpadCapture: NSObject, NSWindowDelegate {
    private let panel: CapturePanel
    private let pad = TrackpadView(frame: .zero)
    private let hint = NSTextField(labelWithString: "")
    private weak var parent: NSWindow?
    private var completion: ((SignatureDrawing?) -> Void)?
    private var observers: [NSObjectProtocol] = []
    private var locked = false
    private var hidden = false
    private var finished = false
    private var timers: [Timer] = []
    private var activationAttempts = 0
    private var originalPointer: CGPoint?
    private var guardPipe: Pipe?
    private var guardProcess: Process?
    private(set) var failure: String?
    var probeKey: UInt16?
    private(set) var handledProbeKey = false

    override init() {
        panel = CapturePanel(
            contentRect: NSRect(x: 0, y: 0, width: 840, height: 525),
            styleMask: [.borderless], backing: .buffered, defer: false
        )
        super.init()
        panel.title = "Draw your signature"
        panel.delegate = self
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.hasShadow = true
        panel.contentView = pad
        pad.frame = NSRect(x: 0, y: 0, width: 840, height: 525)
        pad.autoresizingMask = [.width, .height]
        hint.stringValue = "Enter: apply   Esc: cancel   ⌘Z: undo stroke   Delete: clear   •   Clicks are ignored"
        hint.textColor = .secondaryLabelColor
        hint.font = .systemFont(ofSize: 12)
        hint.isSelectable = false
        hint.alignment = .center
        hint.frame = NSRect(x: 12, y: 12, width: 816, height: 18)
        hint.autoresizingMask = [.width, .maxYMargin]
        pad.addSubview(hint)
    }

    func present(parent: NSWindow, completion: @escaping (SignatureDrawing?) -> Void) {
        self.parent = parent
        self.completion = completion
        panel.capture = self
        (NSApp as? SigningApplication)?.capture = self
        parent.beginSheet(panel)
        panel.makeFirstResponder(pad)
        NSApp.activate(ignoringOtherApps: true)
        if let event = NSApp.currentEvent, event.type == .gesture {
            pad.recorder.ignoreExisting(Set(event.touches(matching: .touching, in: nil).map(TrackpadView.identity)))
        }
        schedule(after: 0.05) { [weak self] in self?.start() }
    }

    private func schedule(after delay: TimeInterval, _ action: @escaping () -> Void) {
        let timer = Timer(timeInterval: delay, repeats: false) { _ in action() }
        timers.append(timer)
        RunLoop.main.add(timer, forMode: .common)
    }

    private func start() {
        guard !finished else { return }
        guard probeKey != nil || (panel.isKeyWindow && NSApp.isActive) else {
            activationAttempts += 1
            if activationAttempts < 60 {
                panel.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
                schedule(after: 0.05) { [weak self] in self?.start() }
            } else {
                failure = "The signing window could not get keyboard focus."
                finish(nil)
            }
            return
        }
        if let probeKey {
            (NSApp as? SigningApplication)?.capture = self
            panel.capture = self
            pad.recorder.begin("probe", at: .zero)
            pad.recorder.end("probe", at: CGPoint(x: 10, y: 10))
            schedule(after: 0.05) { [weak self] in
                guard let self, !self.finished,
                      let key = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                                                windowNumber: self.panel.windowNumber, context: nil,
                                                characters: probeKey == 53 ? "\u{1b}" : "\r", charactersIgnoringModifiers: "",
                                                isARepeat: false, keyCode: probeKey) else { return }
                self.panel.sendEvent(key)
            }
            schedule(after: 2) { [weak self] in
                guard let self, !self.finished else { return }
                self.failure = "Signing modal did not handle key \(probeKey)."
                self.finish(nil)
            }
            return
        }
        do {
            // EOF makes the independent guard restore association if this process dies.
            let pipe = Pipe()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
            process.arguments = ["--restore-pointer"]
            process.standardInput = pipe
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            pipe.fileHandleForReading.closeFile()
            guardPipe = pipe
            guardProcess = process
        } catch {
            failure = "Could not start the pointer-restoration guard."
            finish(nil)
            return
        }
        originalPointer = CGEvent(source: nil)?.location
        let windowPoint = pad.convert(CGPoint(x: pad.bounds.midX, y: pad.bounds.midY), to: nil)
        let screenPoint = panel.convertPoint(toScreen: windowPoint)
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        guard CGWarpMouseCursorPosition(CGPoint(x: screenPoint.x, y: top - screenPoint.y)) == .success,
              CGAssociateMouseAndMouseCursorPosition(0) == .success else {
            _ = CGAssociateMouseAndMouseCursorPosition(1)
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
            failure = "macOS could not lock the pointer. Allow Pi PDF Signer in System Settings → Privacy & Security → Accessibility, then try again."
            finish(nil)
            return
        }
        locked = true
        NSCursor.hide()
        hidden = true
        (NSApp as? SigningApplication)?.capture = self
        panel.capture = self
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: NSApplication.didResignActiveNotification, object: nil, queue: nil) { [weak self] _ in
            self?.finish(nil)
        })
        observers.append(center.addObserver(forName: NSWindow.didResignKeyNotification, object: panel, queue: nil) { [weak self] _ in
            self?.finish(nil)
        })
    }

    func consumeTouches(_ event: NSEvent) {
        guard locked || probeKey != nil else { return }
        pad.consume(event)
    }

    func handleKey(_ event: NSEvent) {
        if event.keyCode == probeKey { handledProbeKey = true }
        switch event.keyCode {
        case 36, 76:
            if pad.recorder.drawing.isEmpty {
                hint.stringValue = "Draw a signature first, or press Esc to cancel."
                NSSound.beep()
            } else { finish(pad.recorder.drawing) }
        case 53: finish(nil)
        case 51, 117:
            pad.recorder.clear()
            pad.needsDisplay = true
        default:
            if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "z" {
                pad.recorder.undo()
                pad.needsDisplay = true
            }
        }
    }

    func finish(_ drawing: SignatureDrawing?) {
        guard !finished else { return }
        finished = true
        restore()
        parent?.endSheet(panel)
        panel.orderOut(nil)
        let callback = completion
        completion = nil
        callback?(drawing)
    }

    func restore() {
        if let app = NSApp as? SigningApplication, app.capture === self { app.capture = nil }
        panel.capture = nil
        timers.forEach { $0.invalidate() }
        timers.removeAll()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
        if locked {
            _ = CGAssociateMouseAndMouseCursorPosition(1)
            locked = false
        }
        if hidden {
            NSCursor.unhide()
            hidden = false
        }
        if let originalPointer {
            _ = CGWarpMouseCursorPosition(originalPointer)
            self.originalPointer = nil
        }
        // A normal release must not let a delayed guard unlock a later session.
        try? guardPipe?.fileHandleForWriting.write(contentsOf: Data([1]))
        guardPipe?.fileHandleForWriting.closeFile()
        guardPipe = nil
        // The guard exits after EOF. Never kill it before its restoration call.
        guardProcess = nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        finish(nil)
        return false
    }

    deinit { restore() }
}
