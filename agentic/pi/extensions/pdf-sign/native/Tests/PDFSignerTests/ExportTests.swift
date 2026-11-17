import AppKit
import PDFKit
import XCTest
@testable import PDFSigner

final class ExportTests: XCTestCase {
    private var folder: URL!
    private var source: URL { folder.appendingPathComponent("Aftale.pdf") }

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("pi-pdf-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var box = CGRect(x: 0, y: 0, width: 420, height: 600)
        let context = try XCTUnwrap(CGContext(source as CFURL, mediaBox: &box, nil))
        for _ in 0..<4 {
            context.beginPDFPage(nil)
            context.setFillColor(NSColor.red.cgColor)
            context.fill(CGRect(x: 40, y: 70, width: 35, height: 45))
            context.setFillColor(NSColor.green.cgColor)
            context.fill(CGRect(x: 300, y: 430, width: 25, height: 35))
            context.endPDFPage()
        }
        context.closePDF()
        let document = try XCTUnwrap(PDFDocument(url: source))
        for index in 0..<4 {
            let page = try XCTUnwrap(document.page(at: index))
            page.setBounds(CGRect(x: 20, y: 40, width: 360, height: 500), for: .cropBox)
            page.rotation = index * 90
        }
        XCTAssertTrue(document.write(to: source))
    }

    override func tearDownWithError() throws { try FileManager.default.removeItem(at: folder) }

    private func bitmap(size: CGSize, draw: (CGContext) -> Void) throws -> [UInt8] {
        let width = Int(size.width)
        let height = Int(size.height)
        let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                                            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(NSColor.white.cgColor)
        context.fill(CGRect(origin: .zero, size: size))
        draw(context)
        let bytes = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
        return Array(UnsafeBufferPointer(start: bytes, count: width * height * 4))
    }

    func testExportMatchesPreviewForCroppedRotatedPagesAndFlattensAdditions() throws {
        let original = try Data(contentsOf: source)
        let document = try PDFExport.open(source)
        let drawing = SignatureDrawing(strokes: [[CGPoint(x: 0, y: 0), CGPoint(x: 60, y: 30), CGPoint(x: 100, y: 10)]])
        var items: [EditorItem] = []
        for page in 0..<4 {
            items.append(EditorItem(page: page, rect: CGRect(x: 80, y: 180, width: 150, height: 60), content: .signature(drawing)))
            items.append(EditorItem(page: page, rect: CGRect(x: 50, y: 120, width: 220, height: 28), content: .text("Søren Ærø — 17/11/2026")))
            items.append(EditorItem(page: page, rect: CGRect(x: 10, y: 10, width: 80, height: 40), content: .signature(nil)))
        }
        let destination = folder.appendingPathComponent(PDFExport.defaultFilename(for: source))
        try PDFExport.write(document: document, items: items, source: source, destination: destination)
        let result = try XCTUnwrap(PDFDocument(url: destination))
        XCTAssertEqual(result.pageCount, 4)
        for index in 0..<4 {
            let originalPage = try XCTUnwrap(document.page(at: index))
            let page = try XCTUnwrap(result.page(at: index))
            let size = PDFExport.displayedSize(of: originalPage)
            XCTAssertEqual(page.bounds(for: .mediaBox).size, size)
            XCTAssertEqual(page.rotation, 0)
            XCTAssertTrue(page.annotations.isEmpty)
            XCTAssertTrue(page.string?.contains("Søren Ærø") == true)
            let reference = try bitmap(size: size) { context in
                let cgPage = originalPage.pageRef!
                context.saveGState()
                context.concatenate(cgPage.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: false))
                context.drawPDFPage(cgPage)
                context.restoreGState()
                for item in items where item.page == index { ItemRenderer.draw(item, in: context) }
            }
            let exported = try bitmap(size: size) { page.draw(with: .mediaBox, to: $0) }
            let differences = zip(reference, exported).filter { abs(Int($0.0) - Int($0.1)) > 30 }.count
            XCTAssertLessThan(Double(differences) / Double(reference.count), 0.008, "Page \(index), rotation \(originalPage.rotation)")
        }
        XCTAssertEqual(try Data(contentsOf: source), original)
        XCTAssertEqual(destination.lastPathComponent, "Aftale-signed.pdf")
        XCTAssertFalse(try FileManager.default.contentsOfDirectory(atPath: folder.path).contains { $0.hasPrefix(".pi-sign-") })
    }

    func testRejectsOriginalSymlinkAndHardlinkWithoutChangingAnyFile() throws {
        let document = try PDFExport.open(source)
        let data = try Data(contentsOf: source)
        let item = EditorItem(page: 0, rect: CGRect(x: 10, y: 10, width: 100, height: 30), content: .text("Dan"))
        let symlink = folder.appendingPathComponent("symlink.pdf")
        let hardlink = folder.appendingPathComponent("hardlink.pdf")
        try FileManager.default.createSymbolicLink(at: symlink, withDestinationURL: source)
        try FileManager.default.linkItem(at: source, to: hardlink)
        for destination in [source, symlink, hardlink] {
            XCTAssertThrowsError(try PDFExport.write(document: document, items: [item], source: source, destination: destination))
            XCTAssertEqual(try Data(contentsOf: source), data)
        }
    }

    func testEmptyBoxesCannotExportOrOverwriteAnExistingDestination() throws {
        let destination = folder.appendingPathComponent("existing.pdf")
        let previous = Data("existing contents".utf8)
        try previous.write(to: destination)
        let item = EditorItem(page: 0, rect: CGRect(x: 10, y: 10, width: 100, height: 30), content: .signature(nil))
        XCTAssertThrowsError(try PDFExport.write(document: PDFExport.open(source), items: [item], source: source, destination: destination))
        XCTAssertEqual(try Data(contentsOf: destination), previous)
    }

    func testExistingDigitalSignatureIsNotSilentlyInvalidated() throws {
        let objects = [
            "<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] >> >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>",
            "<< /Length 0 >>\nstream\n\nendstream",
            "<< /FT /Sig /T (Existing) /V 6 0 R >>",
            "<< /Type /Sig /ByteRange [0 100 200 100] /Contents <0000> >>",
        ]
        var pdf = "%PDF-1.7\n"
        var offsets = [0]
        for (index, object) in objects.enumerated() {
            offsets.append(pdf.utf8.count)
            pdf += "\(index + 1) 0 obj\n\(object)\nendobj\n"
        }
        let xref = pdf.utf8.count
        pdf += "xref\n0 7\n0000000000 65535 f \n"
        for offset in offsets.dropFirst() { pdf += String(format: "%010d 00000 n \n", offset) }
        pdf += "trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n\(xref)\n%%EOF\n"
        try Data(pdf.utf8).write(to: source)
        XCTAssertThrowsError(try PDFExport.open(source)) { error in
            guard case SigningError.digitalSignature = error else { return XCTFail("Wrong error: \(error)") }
        }
    }

    func testEditorCanvasSupportsBoxesResizeMoveDeleteUndoAndText() throws {
        _ = NSApplication.shared
        let editor = try EditorController(source: source) { _ in XCTFail("No export requested") }
        defer { editor.window.orderOut(nil) }
        editor.show()
        editor.window.contentView?.layoutSubtreeIfNeeded()
        editor.window.displayIfNeeded()
        let canvas = editor.canvas
        canvas.zoom = 1
        canvas.updateSize()
        func mouse(_ type: NSEvent.EventType, _ point: CGPoint, clicks: Int = 1) throws -> NSEvent {
            let p = canvas.convert(point, to: nil)
            return try XCTUnwrap(NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: 0,
                                                  windowNumber: editor.window.windowNumber, context: nil,
                                                  eventNumber: 0, clickCount: clicks, pressure: 0))
        }
        canvas.mode = .box
        canvas.mouseDown(with: try mouse(.leftMouseDown, CGPoint(x: 50, y: 250)))
        canvas.mouseDragged(with: try mouse(.leftMouseDragged, CGPoint(x: 210, y: 300)))
        canvas.mouseUp(with: try mouse(.leftMouseUp, CGPoint(x: 210, y: 300)))
        XCTAssertEqual(canvas.model.items.count, 1)
        XCTAssertEqual(canvas.model.items[0].rect, CGRect(x: 50, y: 250, width: 160, height: 50))
        canvas.mouseDown(with: try mouse(.leftMouseDown, CGPoint(x: 210, y: 250)))
        canvas.mouseDragged(with: try mouse(.leftMouseDragged, CGPoint(x: 240, y: 220)))
        canvas.mouseUp(with: try mouse(.leftMouseUp, CGPoint(x: 240, y: 220)))
        XCTAssertEqual(canvas.model.items[0].rect, CGRect(x: 50, y: 220, width: 190, height: 80))
        canvas.mouseDown(with: try mouse(.leftMouseDown, CGPoint(x: 100, y: 250)))
        canvas.mouseDragged(with: try mouse(.leftMouseDragged, CGPoint(x: 120, y: 260)))
        canvas.mouseUp(with: try mouse(.leftMouseUp, CGPoint(x: 120, y: 260)))
        XCTAssertEqual(canvas.model.items[0].rect.origin, CGPoint(x: 70, y: 230))
        let drawing = SignatureDrawing(strokes: [[.zero, CGPoint(x: 60, y: 30), CGPoint(x: 100, y: 10)]])
        canvas.model.apply(drawing, to: canvas.model.selectedSignatureIDs)
        canvas.deleteSelected(nil)
        XCTAssertTrue(canvas.model.items.isEmpty)
        canvas.undo(nil)
        XCTAssertEqual(canvas.model.items.count, 1)
        XCTAssertEqual(canvas.model.items[0].content, .signature(drawing))
        canvas.model.add(EditorItem(page: 0, rect: CGRect(x: 50, y: 140, width: 220, height: 28), content: .text("Søren Ærø — 17/11/2026")))
        editor.window.displayIfNeeded()
        if let screenshot = ProcessInfo.processInfo.environment["PI_PDF_SIGNER_SCREENSHOT"], let view = editor.window.contentView,
           let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) {
            view.cacheDisplay(in: view.bounds, to: bitmap)
            try bitmap.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: screenshot))
        }
    }

    func testInvalidPDFIsRejected() throws {
        let invalid = folder.appendingPathComponent("invalid.pdf")
        try Data("Not a PDF".utf8).write(to: invalid)
        XCTAssertThrowsError(try PDFExport.open(invalid))
    }
}
