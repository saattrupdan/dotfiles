import AppKit
import PDFKit
import UniformTypeIdentifiers

final class PageCanvas: NSView {
    let document: PDFDocument
    var model = EditorModel() { didSet { needsDisplay = true; window?.invalidateCursorRects(for: self); onChange?() } }
    var pageIndex = 0
    var zoom: CGFloat = 1
    var onChange: (() -> Void)?
    var onEditText: ((UUID) -> Void)?
    var onAddText: ((CGPoint) -> Void)?
    var onZoom: ((CGFloat) -> Void)?
    var placingText = false {
        didSet { window?.invalidateCursorRects(for: self); onChange?() }
    }
    private var undoStates: [EditorModel] = []
    private var redoStates: [EditorModel] = []
    private var start: CGPoint?
    private var originals: [UUID: CGRect] = [:]
    private var resizing: UUID?
    private var checkpointed = false
    private var placing = false
    private var dragged = false
    private var contextPoint = CGPoint.zero
    private var contextItem: UUID?

    init(document: PDFDocument) {
        self.document = document
        super.init(frame: .zero)
        wantsLayer = true
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.16
        layer?.shadowRadius = 14
        layer?.shadowOffset = CGSize(width: 0, height: -3)
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
        window?.invalidateCursorRects(for: self)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: placingText ? .iBeam : .crosshair)
        guard !placingText else { return }
        for item in model.items where item.page == pageIndex {
            addCursorRect(NSRect(x: item.rect.minX * zoom, y: item.rect.minY * zoom,
                                 width: item.rect.width * zoom, height: item.rect.height * zoom), cursor: .openHand)
        }
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

    @objc func selectAllSignatures(_ sender: Any?) {
        model.selection = Set(model.items.filter { $0.content.isSignature }.map(\.id))
    }

    override func selectAll(_ sender: Any?) { model.selection = Set(model.items.map(\.id)) }

    override func keyDown(with event: NSEvent) {
        if event.modifierFlags.contains(.command) {
            switch event.charactersIgnoringModifiers?.lowercased() {
            case "a": selectAll(nil); return
            case "z":
                if event.modifierFlags.contains(.shift) { redo(nil) } else { undo(nil) }
                return
            case "+", "=": onZoom?(1.2); return
            case "-": onZoom?(1 / 1.2); return
            default: break
            }
        }
        switch event.keyCode {
        case 51, 117: deleteSelected(nil)
        case 53:
            if placingText { placingText = false }
            else { model.selection.removeAll() }
        default: super.keyDown(with: event)
        }
    }

    override func magnify(with event: NSEvent) { onZoom?(max(0.5, 1 + event.magnification)) }

    private func location(_ event: NSEvent) -> CGPoint {
        let p = convert(event.locationInWindow, from: nil)
        return CGPoint(x: min(pageSize.width, max(0, p.x / zoom)), y: min(pageSize.height, max(0, p.y / zoom)))
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let p = location(event)
        start = p
        resizing = nil
        originals = [:]
        checkpointed = false
        placing = false
        dragged = false
        if placingText {
            placing = !event.modifierFlags.contains(.control)
            return
        }
        let current = model.items.filter { $0.page == pageIndex }
        let tolerance = 9 / zoom
        if let item = current.reversed().first(where: {
            model.selection.contains($0.id) && abs(p.x - $0.rect.maxX) < tolerance && abs(p.y - $0.rect.minY) < tolerance
        }) {
            resizing = item.id
            originals[item.id] = item.rect
            return
        }
        guard let hit = current.reversed().first(where: { $0.rect.contains(p) }) else {
            placing = !event.modifierFlags.contains(.control)
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
        if hypot(p.x - start.x, p.y - start.y) * zoom > 3 { dragged = true }
        guard !originals.isEmpty, dragged else { return }
        if !checkpointed { checkpoint(); checkpointed = true }
        if let resizing, let original = originals[resizing], let index = model.items.firstIndex(where: { $0.id == resizing }) {
            let rect = CGRect(x: original.minX, y: min(p.y, original.maxY - 8), width: max(8, p.x - original.minX), height: max(8, original.maxY - p.y))
            model.items[index].rect = EditorModel.constrained(rect, to: pageSize)
        } else {
            let group = originals.values.reduce(CGRect.null) { $0.union($1) }
            let dx = min(max(p.x - start.x, -group.minX), pageSize.width - group.maxX)
            let dy = min(max(p.y - start.y, -group.minY), pageSize.height - group.maxY)
            for index in model.items.indices {
                if let rect = originals[model.items[index].id] { model.items[index].rect = rect.offsetBy(dx: dx, dy: dy) }
            }
        }
    }

    override func mouseUp(with event: NSEvent) {
        let point = placing && !dragged ? start : nil
        start = nil
        originals = [:]
        resizing = nil
        placing = false
        if let point {
            if placingText {
                placingText = false
                onAddText?(point)
            } else {
                checkpoint()
                model.placeSignature(at: point, page: pageIndex, pageSize: pageSize, extendingSelection: event.modifierFlags.contains(.shift))
            }
        }
        needsDisplay = true
    }

    override func menu(for event: NSEvent) -> NSMenu? {
        contextPoint = location(event)
        let hit = model.items.reversed().first { $0.page == pageIndex && $0.rect.contains(contextPoint) }
        contextItem = hit?.id
        if let hit, !model.selection.contains(hit.id) { model.selection = [hit.id] }
        let menu = NSMenu()
        menu.autoenablesItems = false
        func item(_ title: String, _ action: Selector, enabled: Bool = true) {
            let value = menu.addItem(withTitle: title, action: action, keyEquivalent: "")
            value.target = self
            value.isEnabled = enabled
        }
        item("Add printed text here…", #selector(addTextHere))
        if let hit, case .text = hit.content { item("Edit text…", #selector(editSelectedText)) }
        menu.addItem(.separator())
        item("Delete selected", #selector(deleteSelected(_:)), enabled: !model.selection.isEmpty)
        item("Select all signatures", #selector(selectAllSignatures(_:)), enabled: model.items.contains { $0.content.isSignature })
        menu.addItem(.separator())
        item("Undo", #selector(undo(_:)), enabled: !undoStates.isEmpty)
        item("Redo", #selector(redo(_:)), enabled: !redoStates.isEmpty)
        return menu
    }

    @objc private func addTextHere() {
        placingText = false
        onAddText?(contextPoint)
    }
    @objc private func editSelectedText() {
        if let id = contextItem, model.items.contains(where: { $0.id == id && !$0.content.isSignature }) { onEditText?(id) }
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
            let selected = model.selection.contains(item.id)
            if !item.content.isExportable {
                let shape = NSBezierPath(roundedRect: item.rect, xRadius: 5 / zoom, yRadius: 5 / zoom)
                NSColor.controlAccentColor.withAlphaComponent(0.055).setFill()
                shape.fill()
                let label = "Signature" as NSString
                let font = NSFont.systemFont(ofSize: 12 / zoom, weight: .medium)
                let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: NSColor.controlAccentColor]
                let size = label.size(withAttributes: attributes)
                label.draw(at: CGPoint(x: item.rect.midX - size.width / 2, y: item.rect.midY - size.height / 2), withAttributes: attributes)
            }
            ItemRenderer.draw(item, in: context)
            if selected || !item.content.isExportable {
                context.saveGState()
                context.setStrokeColor(NSColor.controlAccentColor.withAlphaComponent(selected ? 0.8 : 0.4).cgColor)
                context.setLineWidth(1 / zoom)
                context.setLineDash(phase: 0, lengths: item.content.isExportable ? [] : [5 / zoom, 4 / zoom])
                let shape = CGPath(roundedRect: item.rect, cornerWidth: 5 / zoom, cornerHeight: 5 / zoom, transform: nil)
                context.addPath(shape)
                context.strokePath()
                if selected {
                    let radius = 3.5 / zoom
                    let handle = CGRect(x: item.rect.maxX - radius, y: item.rect.minY - radius, width: radius * 2, height: radius * 2)
                    context.setFillColor(NSColor.white.cgColor)
                    context.fillEllipse(in: handle)
                    context.setLineDash(phase: 0, lengths: [])
                    context.strokeEllipse(in: handle)
                }
                context.restoreGState()
            }
        }
        context.restoreGState()
    }
}

final class EditorController: NSObject, NSWindowDelegate {
    let window: NSWindow
    let canvas: PageCanvas
    private let source: URL
    private let scroll = NSScrollView()
    private let status = NSTextField(labelWithString: "Click anywhere on the page to place a signature")
    private let pages = NSPopUpButton()
    private let zoomLabel = NSTextField(labelWithString: "")
    private(set) var header: EditorHeader!
    private var capture: TrackpadCapture?
    private let onFinish: ([String: String]) -> Void

    init(source: URL, onFinish: @escaping ([String: String]) -> Void) throws {
        self.source = source
        self.onFinish = onFinish
        canvas = PageCanvas(document: try PDFExport.open(source))
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1060, height: 850),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        window.title = source.lastPathComponent
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.minSize = CGSize(width: 760, height: 560)
        window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.delegate = self
        buildUI()
        canvas.onChange = { [weak self] in self?.refresh() }
        canvas.onEditText = { [weak self] id in self?.editText(id: id) }
        canvas.onAddText = { [weak self] point in self?.editText(id: nil, point: point) }
        canvas.onZoom = { [weak self] factor in self?.changeZoom(factor) }
        refresh()
    }

    private func buildUI() {
        header = EditorHeader(filename: source.lastPathComponent, target: self, text: #selector(toggleTextPlacement), sign: #selector(signSelected), export: #selector(exportPDF))
        let clip = CenteredPageClip()
        clip.drawsBackground = true
        clip.backgroundColor = .underPageBackgroundColor
        scroll.contentView = clip
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.scrollerStyle = .overlay
        scroll.borderType = .noBorder
        scroll.backgroundColor = .underPageBackgroundColor
        scroll.documentView = canvas
        let footer = NSView(frame: NSRect(x: 0, y: 0, width: 1060, height: 46))
        for index in 0..<canvas.document.pageCount { pages.addItem(withTitle: "Page \(index + 1) of \(canvas.document.pageCount)") }
        pages.isBordered = false
        pages.font = .systemFont(ofSize: 12, weight: .medium)
        pages.isEnabled = canvas.document.pageCount > 1
        pages.target = self
        pages.action = #selector(selectPage)
        pages.frame = NSRect(x: 22, y: 11, width: 132, height: 24)
        pages.toolTip = "Go to a page"
        footer.addSubview(pages)
        status.frame = NSRect(x: 165, y: 14, width: 730, height: 18)
        status.autoresizingMask = [.width]
        status.alignment = .center
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        footer.addSubview(status)
        zoomLabel.frame = NSRect(x: 960, y: 14, width: 74, height: 18)
        zoomLabel.autoresizingMask = [.minXMargin]
        zoomLabel.alignment = .right
        zoomLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        zoomLabel.textColor = .tertiaryLabelColor
        zoomLabel.toolTip = "Pinch to zoom, or use ⌘+ / ⌘−"
        footer.addSubview(zoomLabel)
        window.contentView = EditorSurface(header: header, scroll: scroll, footer: footer)
    }

    func show() {
        if let screen = NSScreen.screens.first(where: { $0.frame.contains(NSEvent.mouseLocation) }) {
            let frame = screen.visibleFrame
            let size = CGSize(width: min(1060, frame.width - 60), height: min(850, frame.height - 60))
            window.setFrame(NSRect(x: frame.midX - size.width / 2, y: frame.midY - size.height / 2, width: size.width, height: size.height), display: false)
        } else { window.center() }
        NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps, .activateAllWindows])
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        window.contentView?.layoutSubtreeIfNeeded()
        fitPage()
        window.makeFirstResponder(canvas)
    }

    private func refresh() {
        let count = canvas.model.selectedSignatureIDs.count
        header.update(pending: count, hasContent: canvas.model.hasContent, capturing: capture != nil, placingText: canvas.placingText)
        pages.selectItem(at: canvas.pageIndex)
        zoomLabel.stringValue = "\(Int(canvas.zoom * 100))%"
        if canvas.placingText {
            status.stringValue = "Click where the text belongs · Esc to cancel"
        } else if count > 0 && !canvas.model.pendingSignatureIDs.isDisjoint(with: canvas.model.selection) {
            status.stringValue = count == 1 ? "Ready to sign · click Sign above" : "\(count) locations ready · Sign once to fill them all"
        } else if canvas.model.hasContent {
            status.stringValue = "Drag to adjust · double-click text to edit · Export when ready"
        } else { status.stringValue = "Click to place a signature · Add text for names, locations, and dates" }
    }

    @objc private func toggleTextPlacement() {
        guard capture == nil else { return }
        canvas.placingText.toggle()
        window.makeFirstResponder(canvas)
    }

    @objc private func signSelected() {
        let ids = canvas.model.selectedSignatureIDs
        guard !ids.isEmpty, capture == nil else { return }
        canvas.placingText = false
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

    private func editText(id: UUID?, point: CGPoint? = nil) {
        let alert = NSAlert()
        alert.messageText = id == nil ? "Add printed text" : "Edit printed text"
        alert.informativeText = "Enter your printed name, location, date, or other text. Drag to move it, drag its corner to resize, or double-click to edit."
        alert.addButton(withTitle: "Apply")
        alert.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 400, height: 28))
        field.placeholderString = "Name, location, date, or other text"
        if let id, let item = canvas.model.items.first(where: { $0.id == id }), case .text(let text) = item.content { field.stringValue = text }
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self else { return }
            defer { self.window.makeFirstResponder(self.canvas) }
            guard response == .alertFirstButtonReturn else { return }
            let text = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            self.canvas.checkpoint()
            if let id, let index = self.canvas.model.items.firstIndex(where: { $0.id == id }) {
                self.canvas.model.items[index].content = .text(text)
            } else {
                let position = point ?? CGPoint(x: self.canvas.pageSize.width / 2, y: self.canvas.pageSize.height / 2)
                self.canvas.model.add(EditorItem(page: self.canvas.pageIndex,
                    rect: ItemRenderer.textRect(text, centeredAt: position, pageSize: self.canvas.pageSize), content: .text(text)))
            }
        }
    }

    @objc private func selectPage() {
        canvas.pageIndex = max(0, pages.indexOfSelectedItem)
        fitPage()
        refresh()
    }

    private func fitPage() {
        let available = scroll.contentSize
        canvas.zoom = max(0.1, min((available.width - 88) / canvas.pageSize.width, (available.height - 64) / canvas.pageSize.height))
        canvas.updateSize()
        scroll.contentView.scroll(to: .zero)
        refresh()
    }

    private func changeZoom(_ factor: CGFloat) {
        canvas.zoom = max(0.1, min(4, canvas.zoom * factor))
        canvas.updateSize()
        refresh()
    }

    @objc private func exportPDF() {
        guard canvas.model.hasContent else { return }
        canvas.placingText = false
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
