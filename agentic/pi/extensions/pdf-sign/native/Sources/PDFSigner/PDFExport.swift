import AppKit
import Darwin
import PDFKit

enum SigningError: LocalizedError {
    case invalidPDF, protectedPDF, digitalSignature, originalDestination, emptyExport, writeFailed

    var errorDescription: String? {
        switch self {
        case .invalidPDF: return "The file could not be opened as a PDF."
        case .protectedPDF: return "This PDF is encrypted or restricts document changes. Open an unrestricted copy instead."
        case .digitalSignature: return "This PDF already contains a digital signature. Flattened export would invalidate it. Use an unsigned copy."
        case .originalDestination: return "Choose a different filename. The original PDF is never overwritten."
        case .emptyExport: return "Add a signature or text before exporting."
        case .writeFailed: return "The signed PDF could not be saved. Check the destination folder and try again."
        }
    }
}

enum PDFExport {
    static func open(_ url: URL) throws -> PDFDocument {
        guard let document = PDFDocument(url: url), document.pageCount > 0 else { throw SigningError.invalidPDF }
        guard !document.isLocked, !document.isEncrypted, document.allowsDocumentChanges, document.allowsPrinting else {
            throw SigningError.protectedPDF
        }
        if let catalog = document.documentRef?.catalog {
            var form: CGPDFDictionaryRef?
            var fields: CGPDFArrayRef?
            if CGPDFDictionaryGetDictionary(catalog, "AcroForm", &form), let form,
               CGPDFDictionaryGetArray(form, "Fields", &fields), let fields,
               containsSignedField(fields, depth: 0) { throw SigningError.digitalSignature }
            var permissions: CGPDFDictionaryRef?
            var certification: CGPDFDictionaryRef?
            if CGPDFDictionaryGetDictionary(catalog, "Perms", &permissions), let permissions,
               CGPDFDictionaryGetDictionary(permissions, "DocMDP", &certification) { throw SigningError.digitalSignature }
        }
        return document
    }

    private static func containsSignedField(_ fields: CGPDFArrayRef, depth: Int) -> Bool {
        guard depth < 32, CGPDFArrayGetCount(fields) < 10_000 else { return true }
        for index in 0..<CGPDFArrayGetCount(fields) {
            var field: CGPDFDictionaryRef?
            guard CGPDFArrayGetDictionary(fields, index, &field), let field else { continue }
            var value: CGPDFDictionaryRef?
            var byteRange: CGPDFArrayRef?
            if CGPDFDictionaryGetDictionary(field, "V", &value), let value,
               CGPDFDictionaryGetArray(value, "ByteRange", &byteRange), let byteRange,
               CGPDFArrayGetCount(byteRange) > 0 { return true }
            var children: CGPDFArrayRef?
            if CGPDFDictionaryGetArray(field, "Kids", &children), let children,
               containsSignedField(children, depth: depth + 1) { return true }
        }
        return false
    }

    static func displayedSize(of page: PDFPage) -> CGSize {
        let size = page.bounds(for: .cropBox).size
        return abs(page.rotation % 180) == 90 ? CGSize(width: size.height, height: size.width) : size
    }

    static func defaultFilename(for source: URL) -> String {
        source.deletingPathExtension().lastPathComponent + "-signed.pdf"
    }

    static func isOriginal(_ destination: URL, source: URL) -> Bool {
        if destination.standardizedFileURL.resolvingSymlinksInPath() == source.standardizedFileURL.resolvingSymlinksInPath() { return true }
        guard let a = try? FileManager.default.attributesOfItem(atPath: source.path),
              let b = try? FileManager.default.attributesOfItem(atPath: destination.path),
              let aFile = a[.systemFileNumber] as? NSNumber,
              let bFile = b[.systemFileNumber] as? NSNumber,
              let aSystem = a[.systemNumber] as? NSNumber,
              let bSystem = b[.systemNumber] as? NSNumber else { return false }
        return aFile == bFile && aSystem == bSystem
    }

    /// Repaint vector page content and additions into new pages; no editable additions.
    static func write(document: PDFDocument, items: [EditorItem], source: URL, destination: URL) throws {
        guard !isOriginal(destination, source: source) else { throw SigningError.originalDestination }
        guard items.contains(where: { $0.content.isExportable }) else { throw SigningError.emptyExport }
        let staging = destination.deletingLastPathComponent().appendingPathComponent(".pi-sign-\(UUID().uuidString).pdf")
        defer { try? FileManager.default.removeItem(at: staging) }
        guard FileManager.default.createFile(atPath: staging.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              let consumer = CGDataConsumer(url: staging as CFURL),
              let context = CGContext(consumer: consumer, mediaBox: nil, nil) else { throw SigningError.writeFailed }
        for index in 0..<document.pageCount {
            guard let page = document.page(at: index) else { context.closePDF(); throw SigningError.invalidPDF }
            let size = displayedSize(of: page)
            guard size.width.isFinite, size.height.isFinite, size.width > 0, size.height > 0 else {
                context.closePDF()
                throw SigningError.invalidPDF
            }
            var box = CGRect(origin: .zero, size: size)
            let data = NSData(bytes: &box, length: MemoryLayout<CGRect>.size)
            context.beginPDFPage([kCGPDFContextMediaBox as String: data] as CFDictionary)
            context.saveGState()
            page.draw(with: .cropBox, to: context)
            context.restoreGState()
            for item in items where item.page == index && item.content.isExportable {
                ItemRenderer.draw(item, in: context)
            }
            context.endPDFPage()
        }
        context.closePDF()
        guard let exported = PDFDocument(url: staging), exported.pageCount == document.pageCount,
              !isOriginal(destination, source: source),
              rename(staging.path, destination.path) == 0 else { throw SigningError.writeFailed }
    }
}
