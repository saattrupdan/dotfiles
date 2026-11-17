import AppKit

/// Two deliberately prominent actions; everything else belongs to the document.
final class SigningButton: NSButton {
    private let symbol: String
    private let prominent: Bool
    private var hovering = false
    private var tracking: NSTrackingArea?

    init(_ title: String, symbol: String, prominent: Bool, target: AnyObject, action: Selector) {
        self.symbol = symbol
        self.prominent = prominent
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        setButtonType(.momentaryPushIn)
        isBordered = false
        focusRingType = .none
        setAccessibilityLabel(title)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override var isEnabled: Bool { didSet { needsDisplay = true } }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.activeInKeyWindow, .mouseEnteredAndExited, .inVisibleRect], owner: self)
        addTrackingArea(area)
        tracking = area
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 18, yRadius: 18)
        let tint: NSColor = isEnabled ? (prominent ? .white : .labelColor) : .tertiaryLabelColor
        let fill: NSColor
        if prominent {
            fill = isEnabled ? .controlAccentColor.withAlphaComponent(isHighlighted ? 0.72 : (hovering ? 0.9 : 1)) : .controlAccentColor.withAlphaComponent(0.1)
        } else {
            fill = .labelColor.withAlphaComponent(isEnabled && (hovering || isHighlighted) ? 0.1 : 0.055)
        }
        fill.setFill()
        shape.fill()
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            shape.lineWidth = 2
            shape.stroke()
        }
        let font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: tint]
        let label = title as NSString
        let size = label.size(withAttributes: attributes)
        let start = (bounds.width - size.width - 23) / 2
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil),
           let context = NSGraphicsContext.current?.cgContext {
            let rect = NSRect(x: start, y: bounds.midY - 7, width: 15, height: 15)
            context.saveGState()
            context.beginTransparencyLayer(auxiliaryInfo: nil)
            image.draw(in: rect)
            context.setBlendMode(.sourceIn)
            tint.setFill()
            rect.fill()
            context.endTransparencyLayer()
            context.restoreGState()
        }
        label.draw(at: NSPoint(x: start + 23, y: bounds.midY - size.height / 2), withAttributes: attributes)
    }
}

final class EditorHeader: NSView {
    let sign: SigningButton
    let export: SigningButton
    private let filename: NSTextField
    private let subtitle = NSTextField(labelWithString: "Click the page to place your signature")
    private let icon = NSImageView()

    override var isFlipped: Bool { true }

    init(filename: String, target: AnyObject, sign: Selector, export: Selector) {
        self.filename = NSTextField(labelWithString: filename)
        self.sign = SigningButton("Sign", symbol: "signature", prominent: true, target: target, action: sign)
        self.export = SigningButton("Export", symbol: "square.and.arrow.up", prominent: false, target: target, action: export)
        super.init(frame: .zero)
        self.filename.font = .systemFont(ofSize: 19, weight: .semibold)
        self.filename.lineBreakMode = .byTruncatingMiddle
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = .secondaryLabelColor
        icon.image = NSImage(systemSymbolName: "doc.text", accessibilityDescription: "PDF document")
        icon.contentTintColor = .controlAccentColor
        icon.imageScaling = .scaleProportionallyUpOrDown
        self.sign.keyEquivalent = "s"
        self.sign.keyEquivalentModifierMask = [.command]
        self.sign.toolTip = "Draw a signature for the selected locations (⌘S)"
        self.export.keyEquivalent = "e"
        self.export.keyEquivalentModifierMask = [.command]
        self.export.toolTip = "Export a signed PDF copy (⌘E)"
        for view in [icon, self.filename, subtitle, self.sign, self.export] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layout() {
        super.layout()
        icon.frame = NSRect(x: 30, y: 45, width: 30, height: 34)
        filename.frame = NSRect(x: 76, y: 40, width: max(150, bounds.width - 360), height: 26)
        subtitle.frame = NSRect(x: 76, y: 70, width: max(150, bounds.width - 360), height: 18)
        sign.frame = NSRect(x: bounds.width - 246, y: 47, width: 100, height: 38)
        export.frame = NSRect(x: bounds.width - 136, y: 47, width: 108, height: 38)
    }

    func update(pending: Int, hasContent: Bool, capturing: Bool) {
        sign.isEnabled = pending > 0 && !capturing
        export.isEnabled = hasContent && !capturing
        subtitle.stringValue = pending > 1 ? "\(pending) locations selected · draw once to sign them all" : "Click the page to place your signature"
    }
}

/// Center a small page inside the viewport instead of anchoring it in a corner.
final class CenteredPageClip: NSClipView {
    override func constrainBoundsRect(_ proposedBounds: NSRect) -> NSRect {
        var result = super.constrainBoundsRect(proposedBounds)
        if let size = documentView?.frame.size {
            if size.width < result.width { result.origin.x = -(result.width - size.width) / 2 }
            if size.height < result.height { result.origin.y = -(result.height - size.height) / 2 }
        }
        return result
    }
}

final class EditorSurface: NSView {
    let header: EditorHeader
    let scroll: NSScrollView
    let footer: NSView
    override var isFlipped: Bool { true }

    init(header: EditorHeader, scroll: NSScrollView, footer: NSView) {
        self.header = header
        self.scroll = scroll
        self.footer = footer
        super.init(frame: NSRect(x: 0, y: 0, width: 1060, height: 850))
        for view in [header, scroll, footer] { addSubview(view) }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override func layout() {
        super.layout()
        header.frame = NSRect(x: 0, y: 0, width: bounds.width, height: 112)
        scroll.frame = NSRect(x: 0, y: 112, width: bounds.width, height: max(100, bounds.height - 158))
        footer.frame = NSRect(x: 0, y: bounds.height - 46, width: bounds.width, height: 46)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill()
        bounds.fill()
    }
}
