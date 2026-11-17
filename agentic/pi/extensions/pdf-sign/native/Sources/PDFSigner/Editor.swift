import AppKit
import PDFKit
import UniformTypeIdentifiers

enum EditorMode { case select, box }

final class PageCanvas: NSView {
    let document: PDFDocument
    var model = EditorModel() { didSet { needsDisplay = true; onChange?() } }
    var mode: EditorMode = .select { didSet { onChange?() } }
    var pageIndex = 0
    var zoom: CGFloat = 1
    var onChange: (() -> Void)?
    var onEditText: ((UUID) -> Void)?
    private var undoStates: [EditorModel] = []
    private var redoStates: [EditorModel] = []
    private var start: CGPoint?
    private var draft: CGRect?
    private var originals: [UUID: CGRect] = [:]
    private var resizing: UUID?
    private var checkpointed = false

    init(document: PDFDocument) {
        self.document = document
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { true }

    var pageSize: CGSize {
        document.page(at: pageIndex).map(PDFExport.displayedSize) ?? CGSize(width: 612, height: 792)
    }

    func updateSize() {
        frame.size = CGSize(width: pageSize.width * zoom, height: pageSize.height * zoom)
        needsDisplay = true
    }

    func checkpoint() {
        undoStates.append(model)
        if undoStates.count > 100 { undoStates.removeFirst() }
        redoStates.removeAll()
    }

    @objc func undo(_ sender: Any?) {
        guard let previous = undoStates.popLast() else { return }
        redoStates.append(model)
        model = previous
    }

    @objc func redo(_ sender: Any?) {
        guard let next = redoStates.popLast() else { return }
        undoStates.append(model)
        model = next
    }

    @objc func deleteSelected(_ sender: Any?) {
        guard !model.selection.isEmpty else { return }
        checkpoint()
        model.deleteSelection()
    }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "a": model.selection = Set(model.items.map(\.id)); return
            case "z":
                if event.modifierFlags.contains(.shift) { redo(nil) } else { undo(nil) }
                return
            default: break
            }
        }
        switch event.keyCode {
        case 51, 117: deleteSelected(nil)
        case 53: mode = .select; model.selection.removeAll()
        default: super.keyDown(with: event)
        }
    }

    private func location(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return CGPoint(x: min(pageSize.width, max(0, p.x / zoom)), y: min(pageSize.height, max(0, p.y / zoom)))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let p = location(event)
        start = p
        draft = nil
        resizing = nil
        originals = [:]
        checkpointed = false
        guard mode == .select else { return }
        let current = model.items.filter { $0.page == pageIndex }
        let tolerance = 8 / zoom
        if let item = current.reversed().first(where: {
            model.selection.contains($0.id) && abs(p.x - $0.rect.maxX) < tolerance && abs(p.y - $0.rect.minY) < tolerance
        }) {
            resizing = item.id
            originals[item.id] = item.rect
            return
        }
        guard let hit = current.reversed().first(where: { $0.rect.contains(p) }) else {
            if !event.modifierFlags.contains(.shift) { model.selection.removeAll() }
            return
        }
        if event.modifierFlags.contains(.shift) {
            if model.selection.contains(hit.id) { model.selection.remove(hit.id) }
            else { model.selection.insert(hit.id) }
        } else if !model.selection.contains(hit.id) { model.selection = [hit.id] }
        if event.clickCount == 2, case .text = hit.content {
            start = nil
            onEditText?(hit.id)
            return
        }
        if model.selection.contains(hit.id) {
            originals = Dictionary(uniqueKeysWithValues: current.filter { model.selection.contains($0.id) }.map { ($0.id, $0.rect) })
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let p = location(event)
        if mode == .box {
            draft = CGRect(x: min(start.x, p.x), y: min(start.y, p.y), width: abs(p.x - start.x), height: abs(p.y - start.y))
            needsDisplay = true
            return
        }
        guard !originals.isEmpty else { return }
        if !checkpointed { checkpoint(); checkpointed = true }
        if let resizing, let original = originals[resizing], let index = model.items.firstIndex(where: { $0.id == resizing }) {
            let rect = CGRect(x: original.minX, y: min(p.y, original.maxY - 8), width: max(8, p.x - original.minX), height: max(8, original.maxY - p.y))
            model.items[index].rect = EditorModel.constrained(rect, to: pageSize)
        } else {
            let group = originals.values.reduce(CGRect.null) { $0.union($1) }
            let dx = min(max(p.x - start.x, -group.minX), pageSize.width - group.maxX)
            let dy = min(max(p.y - start.y, -group.minY), pageSize.height - group.maxY)
            for index in model.items.indices {
                if let rect = originals[model.items[index].id] {
                    model.items[index].rect = rect.offsetBy(dx: dx, dy: dy)
                }
            }
        }
    }

    override func mouseUp(with event: NSEvent) {
        if mode == .box, let draft, draft.width >= 12, draft.height >= 10 {
            checkpoint()
            model.add(EditorItem(page: pageIndex, rect: draft, content: .signature(nil)))
            mode = .select
        }
        start = nil
        draft = nil
        originals = [:]
        resizing = nil
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.setFill()
        bounds.fill()
        guard let context = NSGraphicsContext.current?.cgContext, let page = document.page(at: pageIndex) else { return }
        context.saveGState()
        context.scaleBy(x: zoom, y: zoom)
        context.saveGState()
        page.draw(with: .cropBox, to: context)
        context.restoreGState()
        for item in model.items where item.page == pageIndex {
            ItemRenderer.draw(item, in: context)
            let selected = model.selection.contains(item.id)
            if selected || !item.content.isExportable {
                context.saveGState()
                context.setStrokeColor((selected ? NSColor.controlAccentColor : NSColor.systemGray).cgColor)
                context.setLineWidth(1.2 / zoom)
                context.setLineDash(phase: 0, lengths: selected ? [] : [5 / zoom, 3 / zoom])
                context.stroke(item.rect)
                if selected {
                    let handle = 7 / zoom
                    context.setFillColor(NSColor.controlAccentColor.cgColor)
                    context.fill(CGRect(x: item.rect.maxX - handle / 2, y: item.rect.minY - handle / 2, width: handle, height: handle))
                }
                context.restoreGState()
            }
        }
        if let draft {
            context.setStrokeColor(NSColor.controlAccentColor.cgColor)
            context.setLineWidth(1 / zoom)
            context.setLineDash(phase: 0, lengths: [4 / zoom, 3 / zoom])
            context.stroke(draft)
        }
        context.restoreGState()
    }
}

final class EditorController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let canvas: PageCanvas
    private let source: URL
    private let scroll = NSScrollView()
    private let status = NSTextField(labelWithString: "")
    private let pageLabel = NSTextField(labelWithString: "")
    private let signButton = NSButton()
    private let boxButton = NSButton()
    private let exportButton = NSButton()
    private var capture: TrackpadCapture?
    private let onFinish: ([String: String]) -> Void

    init(source: URL, onFinish: @escaping ([String: String]) -> Void) throws {
        self.source = source
        self.onFinish = onFinish
        canvas = PageCanvas(document: try PDFExport.open(source))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1180, height: 860),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "\(source.lastPathComponent) — Pi PDF Signer"
        window.minSize = CGSize(width: 1080, height: 620)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.delegate = self
        buildUI()
        canvas.onChange = { [weak self] in self?.refresh() }
        canvas.onEditText = { [weak self] id in self?.editText(id: id) }
        refresh()
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }

    private func buildUI() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 1180, height: 860))
        window.contentView = root
        boxButton.title = "Add signature box"
        boxButton.target = self
        boxButton.action = #selector(addBox)
        boxButton.setButtonType(.toggle)
        signButton.target = self
        signButton.action = #selector(signSelected)
        exportButton.title = "Export signed version"
        exportButton.target = self
        exportButton.action = #selector(exportPDF)
        let toolbar = NSStackView(views: [
            button("Select", #selector(selectMode)), boxButton,
            button("Select all boxes", #selector(selectAllBoxes)), signButton,
            button("Add name/date text", #selector(addText)),
            button("Delete", #selector(deleteSelected)), button("Undo", #selector(undo)), exportButton,
        ])
        toolbar.orientation = .horizontal
        toolbar.spacing = 8
        toolbar.frame = NSRect(x: 16, y: 810, width: 1148, height: 32)
        toolbar.autoresizingMask = [.width, .minYMargin]
        root.addSubview(toolbar)
        let help = NSTextField(labelWithString: "Shift-click to select multiple • Drag to move • Drag a lower-right handle to resize • Double-click text to edit")
        help.textColor = .secondaryLabelColor
        help.font = .systemFont(ofSize: 11)
        let nav = NSStackView(views: [button("Previous", #selector(previousPage)), pageLabel, button("Next", #selector(nextPage)),
                                     button("Fit page", #selector(fitPage)), button("−", #selector(zoomOut)), button("+", #selector(zoomIn)), help])
        nav.orientation = .horizontal
        nav.spacing = 8
        nav.frame = NSRect(x: 16, y: 773, width: 1148, height: 28)
        nav.autoresizingMask = [.width, .minYMargin]
        root.addSubview(nav)
        scroll.frame = NSRect(x: 16, y: 42, width: 1148, height: 720)
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.borderType = .bezelBorder
        scroll.backgroundColor = .underPageBackgroundColor
        scroll.documentView = canvas
        root.addSubview(scroll)
        status.frame = NSRect(x: 16, y: 12, width: 1148, height: 20)
        status.autoresizingMask = [.width, .maxYMargin]
        status.textColor = .secondaryLabelColor
        root.addSubview(status)
    }

    func show() {
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        fitPage()
        window.makeFirstResponder(canvas)
    }

    private func refresh() {
        let count = canvas.model.selectedSignatureIDs.count
        signButton.title = count > 1 ? "Sign selected boxes (\(count))" : "Sign selected box"
        signButton.isEnabled = count > 0 && capture == nil
        exportButton.isEnabled = canvas.model.hasContent && capture == nil
        boxButton.state = canvas.mode == .box ? .on : .off
        pageLabel.stringValue = "Page \(canvas.pageIndex + 1) / \(canvas.document.pageCount)"
        status.stringValue = canvas.mode == .box ? "Drag a rectangle on the page to create a signature box." :
            "\(count) signature box\(count == 1 ? "" : "es") selected across the document. Changes stay in memory until export."
    }

    @objc private func selectMode() { canvas.mode = .select; window.makeFirstResponder(canvas) }
    @objc private func addBox() { canvas.mode = .box; window.makeFirstResponder(canvas) }
    @objc private func selectAllBoxes() { canvas.model.selection = Set(canvas.model.items.filter { $0.content.isSignature }.map(\.id)) }
    @objc private func deleteSelected() { canvas.deleteSelected(nil) }
    @objc private func undo() { canvas.undo(nil) }

    @objc private func signSelected() {
        let ids = canvas.model.selectedSignatureIDs
        guard !ids.isEmpty, capture == nil else { return }
        let capture = TrackpadCapture()
        self.capture = capture
        refresh()
        capture.present(parent: window) { [weak self, weak capture] drawing in
            guard let self, let capture else { return }
            if let drawing {
                self.canvas.checkpoint()
                self.canvas.model.apply(drawing, to: ids)
            }
            self.capture = nil
            self.refresh()
            self.window.makeFirstResponder(self.canvas)
            if let failure = capture.failure { self.showError(failure) }
        }
    }

    @objc private func addText() { editText(id: nil) }

    private func editText(id: UUID?) {
        let alert = NSAlert()
        alert.messageText = id == nil ? "Add name or date text" : "Edit text"
        alert.addButton(withTitle: "Apply")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 400, height: 28))
        field.placeholderString = "Type your name, date, or other text"
        if let id, let item = canvas.model.items.first(where: { $0.id == id }), case .text(let text) = item.content {
            field.stringValue = text
        }
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .alertFirstButtonReturn else { return }
            let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            self.canvas.checkpoint()
            if let id, let index = self.canvas.model.items.firstIndex(where: { $0.id == id }) {
                self.canvas.model.items[index].content = .text(text)
            } else {
                let visible = self.canvas.visibleRect
                let rect = CGRect(x: visible.midX / self.canvas.zoom - 110, y: visible.midY / self.canvas.zoom - 14, width: 220, height: 28)
                self.canvas.model.add(EditorItem(page: self.canvas.pageIndex,
                    rect: EditorModel.constrained(rect, to: self.canvas.pageSize), content: .text(text)))
            }
            self.window.makeFirstResponder(self.canvas)
        }
    }

    @objc private func previousPage() { changePage(-1) }
    @objc private func nextPage() { changePage(1) }

    private func changePage(_ delta: Int) {
        canvas.pageIndex = min(canvas.document.pageCount - 1, max(0, canvas.pageIndex + delta))
        fitPage()
        refresh()
    }

    @objc private func fitPage() {
        let available = scroll.contentSize
        canvas.zoom = max(0.1, min((available.width - 20) / canvas.pageSize.width, (available.height - 20) / canvas.pageSize.height))
        canvas.updateSize()
        scroll.contentView.scroll(to: CGPoint(x: 0, y: max(0, canvas.frame.height - available.height)))
    }

    @objc private func zoomIn() { canvas.zoom = min(4, canvas.zoom * 1.25); canvas.updateSize() }
    @objc private func zoomOut() { canvas.zoom = max(0.1, canvas.zoom / 1.25); canvas.updateSize() }

    @objc private func exportPDF() {
        guard canvas.model.hasContent else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.canCreateDirectories = true
        panel.directoryURL = source.deletingLastPathComponent()
        panel.nameFieldStringValue = PDFExport.defaultFilename(for: source)
        panel.title = "Export signed version"
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let destination = panel.url else { return }
            do {
                try PDFExport.write(document: self.canvas.document, items: self.canvas.model.items, source: self.source, destination: destination)
                self.onFinish(["status": "exported", "path": destination.path])
            } catch { self.showError(error.localizedDescription) }
        }
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard !canvas.model.items.isEmpty else { onFinish(["status": "cancelled"]); return true }
        let alert = NSAlert()
        alert.messageText = "Discard changes?"
        alert.informativeText = "Your original PDF has not been changed."
        alert.addButton(withTitle: "Keep editing")
        alert.addButton(withTitle: "Discard")
        alert.beginSheetModal(for: window) { [weak self] response in
            if response == .alertSecondButtonReturn { self?.onFinish(["status": "cancelled"]) }
        }
        return false
    }
}
