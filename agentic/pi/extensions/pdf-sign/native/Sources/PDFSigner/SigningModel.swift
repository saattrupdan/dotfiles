import AppKit

struct SignatureDrawing: Equatable {
    var strokes: [[CGPoint]] = []

    var isEmpty: Bool { strokes.allSatisfy(\.isEmpty) }

    var bounds: CGRect {
        let points = strokes.flatMap { $0 }
        guard let first = points.first else { return .zero }
        let xs = points.map(\.x)
        let ys = points.map(\.y)
        return CGRect(
            x: xs.min() ?? first.x, y: ys.min() ?? first.y,
            width: max(2, (xs.max() ?? first.x) - (xs.min() ?? first.x)),
            height: max(2, (ys.max() ?? first.y) - (ys.min() ?? first.y))
        ).insetBy(dx: -1, dy: -1)
    }
}

/// One finger owns a stroke until lift. Other fingers and pressure never change it.
struct StrokeRecorder {
    private(set) var drawing = SignatureDrawing()
    private var finger: AnyHashable?
    private var ignored: Set<AnyHashable> = []

    mutating func ignoreExisting(_ identities: Set<AnyHashable>) {
        ignored = identities
    }

    mutating func begin(_ identity: AnyHashable, at point: CGPoint) {
        guard finger == nil, !ignored.contains(identity) else { return }
        finger = identity
        drawing.strokes.append([point])
    }

    mutating func move(_ identity: AnyHashable, to point: CGPoint) {
        guard finger == identity, !drawing.strokes.isEmpty else { return }
        if drawing.strokes.last?.last != point {
            drawing.strokes[drawing.strokes.count - 1].append(point)
        }
    }

    mutating func end(_ identity: AnyHashable, at point: CGPoint?) {
        if let point { move(identity, to: point) }
        if finger == identity { finger = nil }
        ignored.remove(identity)
    }

    mutating func interrupt() { finger = nil }

    mutating func undo() {
        finger = nil
        if !drawing.strokes.isEmpty { drawing.strokes.removeLast() }
    }

    mutating func clear() {
        finger = nil
        drawing = SignatureDrawing()
    }
}

enum ItemContent: Equatable {
    case signature(SignatureDrawing?)
    case text(String)

    var isSignature: Bool {
        if case .signature = self { return true }
        return false
    }

    var isExportable: Bool {
        switch self {
        case .signature(let drawing): return drawing?.isEmpty == false
        case .text(let text): return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
}

struct EditorItem: Equatable, Identifiable {
    let id: UUID
    let page: Int
    var rect: CGRect
    var content: ItemContent

    init(page: Int, rect: CGRect, content: ItemContent, id: UUID = UUID()) {
        self.id = id
        self.page = page
        self.rect = rect
        self.content = content
    }
}

/// Rectangles use the displayed, rotated crop-page coordinates, bottom-left origin.
struct EditorModel {
    var items: [EditorItem] = []
    var selection: Set<UUID> = []

    var selectedSignatureIDs: Set<UUID> {
        Set(items.filter { selection.contains($0.id) && $0.content.isSignature }.map(\.id))
    }

    var hasContent: Bool { items.contains { $0.content.isExportable } }

    var pendingSignatureIDs: Set<UUID> {
        Set(items.filter { $0.content.isSignature && !$0.content.isExportable }.map(\.id))
    }

    mutating func placeSignature(at point: CGPoint, page: Int, pageSize: CGSize, extendingSelection: Bool = false) {
        let size = CGSize(width: min(176, pageSize.width), height: min(58, pageSize.height))
        let rect = Self.constrained(CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2,
                                          width: size.width, height: size.height), to: pageSize)
        let previous = extendingSelection ? selection : pendingSignatureIDs
        let item = EditorItem(page: page, rect: rect, content: .signature(nil))
        items.append(item)
        selection = previous.union([item.id])
    }

    mutating func add(_ item: EditorItem) {
        items.append(item)
        selection = [item.id]
    }

    mutating func apply(_ drawing: SignatureDrawing, to ids: Set<UUID>) {
        guard !drawing.isEmpty else { return }
        for index in items.indices where ids.contains(items[index].id) && items[index].content.isSignature {
            items[index].content = .signature(drawing)
        }
    }

    mutating func deleteSelection() {
        items.removeAll { selection.contains($0.id) }
        selection.removeAll()
    }

    static func constrained(_ rect: CGRect, to size: CGSize) -> CGRect {
        let width = min(size.width, max(8, rect.width))
        let height = min(size.height, max(8, rect.height))
        return CGRect(
            x: min(max(0, rect.minX), max(0, size.width - width)),
            y: min(max(0, rect.minY), max(0, size.height - height)),
            width: width, height: height
        )
    }
}

enum ItemRenderer {
    private static func textAttributes(fontSize: CGFloat) -> [NSAttributedString.Key: Any] {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineBreakMode = .byWordWrapping
        return [.font: NSFont.systemFont(ofSize: fontSize), .foregroundColor: NSColor.black, .paragraphStyle: paragraph]
    }

    /// Measure with the same font and wrapping used by preview and export.
    static func textRect(_ text: String, centeredAt point: CGPoint, pageSize: CGSize) -> CGRect {
        let attributes = textAttributes(fontSize: 18)
        let string = text as NSString
        let width = min(pageSize.width, max(220, ceil(string.size(withAttributes: attributes).width) + 4))
        let measured = string.boundingRect(with: CGSize(width: max(1, width - 4), height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: attributes)
        let height = max(28, ceil(measured.height) + 4)
        return EditorModel.constrained(CGRect(x: point.x - width / 2, y: point.y - height / 2,
            width: width, height: height), to: pageSize)
    }

    static func draw(_ item: EditorItem, in context: CGContext) {
        switch item.content {
        case .signature(let drawing):
            if let drawing { draw(drawing, in: item.rect.insetBy(dx: 3, dy: 3), context: context) }
        case .text(let text):
            let fontSize = max(4, min(18, item.rect.height * 0.65))
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
            (text as NSString).draw(in: item.rect, withAttributes: textAttributes(fontSize: fontSize))
            NSGraphicsContext.restoreGraphicsState()
        }
    }

    static func draw(_ drawing: SignatureDrawing, in rect: CGRect, context: CGContext) {
        guard !drawing.isEmpty, rect.width > 0, rect.height > 0 else { return }
        let bounds = drawing.bounds
        let scale = min(rect.width / bounds.width, rect.height / bounds.height)
        context.saveGState()
        context.clip(to: rect)
        context.translateBy(x: rect.midX, y: rect.midY)
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -bounds.midX, y: -bounds.midY)
        context.setStrokeColor(NSColor.black.cgColor)
        context.setFillColor(NSColor.black.cgColor)
        let lineWidth = max(0.7, min(1.4, rect.height / 35)) / scale
        context.setLineWidth(lineWidth)
        context.setLineCap(.round)
        context.setLineJoin(.round)
        for stroke in drawing.strokes {
            guard let first = stroke.first else { continue }
            if stroke.count == 1 {
                let radius = lineWidth / 2
                context.fillEllipse(in: CGRect(x: first.x - radius, y: first.y - radius, width: radius * 2, height: radius * 2))
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
