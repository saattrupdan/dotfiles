import AppKit
import Darwin

@main
struct PDFSignerMain {
    static func main() {
        if CommandLine.arguments.contains("--restore-pointer") {
            let releasedNormally = !FileHandle.standardInput.readDataToEndOfFile().isEmpty
            if !releasedNormally { _ = CGAssociateMouseAndMouseCursorPosition(1) }
            return
        }
        let app = SigningApplication.shared
        app.setActivationPolicy(.regular)
        let delegate = SignerDelegate()
        app.delegate = delegate
        withExtendedLifetime(delegate) { app.run() }
    }
}

final class SignerDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var terminationSource: DispatchSourceSignal?
    private var interruptSource: DispatchSourceSignal?
    private var replied = false
    private var capture: TrackpadCapture?
    private var editor: EditorController?
    private var probeResults: [String] = []

    func applicationDidFinishLaunching(_ notification: Notification) {
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        terminationSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        interruptSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        for source in [terminationSource, interruptSource] {
            source?.setEventHandler { [weak self] in self?.reply(["status": "cancelled"]) }
            source?.resume()
        }
        installMenu()
        if CommandLine.arguments.contains("--capture-check") || CommandLine.arguments.contains("--event-check") {
            let button = NSButton(title: "Begin trackpad check", target: self, action: #selector(checkCapture))
            let content = NSStackView(views: [
                NSTextField(labelWithString: "Draw with one finger, press the trackpad while drawing, then press Enter."),
                NSTextField(labelWithString: "Check that the pointer stays still and clicks do not interrupt the ink."),
                button,
            ])
            content.orientation = .vertical
            content.spacing = 18
            content.edgeInsets = NSEdgeInsets(top: 30, left: 30, bottom: 30, right: 30)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 720, height: 180), styleMask: [.titled, .closable], backing: .buffered, defer: false)
            window.title = "Pi PDF Signer — Trackpad check"
            window.contentView = content
            window.delegate = self
            window.isReleasedWhenClosed = false
            self.window = window
            window.center()
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            if CommandLine.arguments.contains("--event-check") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
                    guard let self else { return }
                    self.checkNextKey([53, 36])
                }
            }
            return
        }
        guard let index = CommandLine.arguments.firstIndex(of: "--input"), CommandLine.arguments.count > index + 1 else {
            reply(["status": "error", "message": "Expected a PDF path."])
            return
        }
        do {
            let editor = try EditorController(source: URL(fileURLWithPath: CommandLine.arguments[index + 1])) { [weak self] result in
                self?.reply(result)
            }
            self.editor = editor
            window = editor.window
            editor.show()
            if CommandLine.arguments.contains("--notify-ready") {
                // Dedicated inherited pipe: never mix readiness with the private result channel.
                try? FileHandle(fileDescriptor: 3, closeOnDealloc: false).write(contentsOf: Data("ready\n".utf8))
            }
        } catch { reply(["status": "error", "message": error.localizedDescription]) }
    }

    private func installMenu() {
        let menu = NSMenu()
        let appItem = NSMenuItem()
        menu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Pi PDF Signer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let editItem = NSMenuItem()
        menu.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: #selector(PageCanvas.undo(_:)), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: #selector(PageCanvas.redo(_:)), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        for (title, action, key) in [("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            edit.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        editItem.submenu = edit
        NSApp.mainMenu = menu
    }

    private func checkNextKey(_ keys: [UInt16]) {
        guard let key = keys.first, let window else {
            reply(["status": probeResults.allSatisfy { $0.hasSuffix("handled") && !$0.hasSuffix("not handled") } ? "passed" : "error",
                   "message": probeResults.joined(separator: "; ")])
            return
        }
        let capture = TrackpadCapture()
        self.capture = capture
        capture.probeKey = key
        capture.present(parent: window) { [weak self, weak capture] _ in
            guard let self, let capture else { return }
            self.probeResults.append("\(key): \(capture.failure ?? (capture.handledProbeKey ? "handled" : "not handled"))")
            self.capture = nil
            DispatchQueue.main.async { self.checkNextKey(Array(keys.dropFirst())) }
        }
    }

    @objc private func checkCapture() {
        guard let window else { return }
        let capture = TrackpadCapture()
        self.capture = capture
        capture.present(parent: window) { [weak self, weak capture] drawing in
            guard let self, let capture else { return }
            let alert = NSAlert()
            alert.messageText = drawing == nil ? "Capture cancelled" : "Signature captured"
            alert.informativeText = capture.failure ?? "\(drawing?.strokes.count ?? 0) strokes. Normal pointer control has been restored."
            self.capture = nil
            alert.beginSheetModal(for: window)
        }
    }

    func reply(_ value: [String: String]) {
        guard !replied else { return }
        replied = true
        (NSApp as? SigningApplication)?.capture?.finish(nil)
        if let data = try? JSONSerialization.data(withJSONObject: value) {
            if let index = CommandLine.arguments.firstIndex(of: "--result"), CommandLine.arguments.count > index + 1 {
                try? data.write(to: URL(fileURLWithPath: CommandLine.arguments[index + 1]), options: .atomic)
            }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        (NSApp as? SigningApplication)?.capture?.restore()
        if !replied {
            replied = true
            FileHandle.standardOutput.write(Data("{\"status\":\"cancelled\"}\n".utf8))
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
