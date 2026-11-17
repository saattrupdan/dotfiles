import AppKit
import XCTest
@testable import PDFSigner

final class SigningTests: XCTestCase {
    func testOneFingerOwnsEachStroke() {
        var recorder = StrokeRecorder()
        recorder.begin("first", at: CGPoint(x: 10, y: 20))
        recorder.begin("second", at: CGPoint(x: 90, y: 90))
        recorder.move("second", to: CGPoint(x: 100, y: 100))
        recorder.move("first", to: CGPoint(x: 30, y: 40))
        recorder.end("first", at: CGPoint(x: 50, y: 60))
        recorder.begin("third", at: CGPoint(x: 70, y: 80))
        XCTAssertEqual(recorder.drawing.strokes, [
            [CGPoint(x: 10, y: 20), CGPoint(x: 30, y: 40), CGPoint(x: 50, y: 60)],
            [CGPoint(x: 70, y: 80)],
        ])
    }

    func testOpeningContactMustLiftBeforeDrawing() {
        var recorder = StrokeRecorder()
        recorder.ignoreExisting(["click"])
        recorder.begin("click", at: .zero)
        recorder.move("click", to: CGPoint(x: 10, y: 10))
        XCTAssertTrue(recorder.drawing.isEmpty)
        recorder.end("click", at: nil)
        recorder.begin("click", at: .zero)
        XCTAssertEqual(recorder.drawing.strokes.count, 1)
    }

    func testUndoClearAndInterruptedStroke() {
        var recorder = StrokeRecorder()
        recorder.begin(1, at: .zero)
        recorder.interrupt()
        recorder.move(1, to: CGPoint(x: 1, y: 1))
        recorder.begin(2, at: CGPoint(x: 3, y: 3))
        recorder.undo()
        XCTAssertEqual(recorder.drawing.strokes, [[.zero]])
        recorder.clear()
        XCTAssertTrue(recorder.drawing.isEmpty)
    }

    func testAllClicksDragsAndPressureAreInertDuringCapture() {
        for type: NSEvent.EventType in [.leftMouseDown, .leftMouseUp, .rightMouseDown,
            .rightMouseUp, .otherMouseDown, .otherMouseUp, .mouseMoved,
            .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .pressure,
            .scrollWheel, .magnify, .smartMagnify, .rotate, .swipe] {
            XCTAssertTrue(SigningApplication.ignoresDuringCapture(type), "\(type)")
        }
        XCTAssertFalse(SigningApplication.ignoresDuringCapture(.keyDown))
        XCTAssertFalse(SigningApplication.ignoresDuringCapture(.gesture))
    }

    func testAppliesOneDrawingOnlyToSelectedSignatureBoxesAcrossPages() {
        var model = EditorModel()
        let a = EditorItem(page: 0, rect: CGRect(x: 10, y: 10, width: 100, height: 40), content: .signature(nil))
        let b = EditorItem(page: 1, rect: a.rect, content: .signature(nil))
        let c = EditorItem(page: 1, rect: a.rect, content: .signature(nil))
        let text = EditorItem(page: 0, rect: a.rect, content: .text("Søren Ærø"))
        model.items = [a, b, c, text]
        model.selection = [a.id, b.id, text.id]
        let drawing = SignatureDrawing(strokes: [[.zero, CGPoint(x: 10, y: 20)]])
        model.apply(drawing, to: model.selectedSignatureIDs)
        XCTAssertEqual(model.items[0].content, .signature(drawing))
        XCTAssertEqual(model.items[1].content, .signature(drawing))
        XCTAssertEqual(model.items[2].content, .signature(nil))
        XCTAssertEqual(model.items[3].content, .text("Søren Ærø"))
        model.deleteSelection()
        XCTAssertEqual(model.items, [c])
    }

    func testClickPlacementSelectsAllPendingLocationsButNotAlreadySignedOnes() {
        var model = EditorModel()
        let size = CGSize(width: 600, height: 800)
        model.placeSignature(at: CGPoint(x: 120, y: 200), page: 0, pageSize: size)
        let first = model.items[0]
        model.placeSignature(at: CGPoint(x: 300, y: 400), page: 1, pageSize: size)
        XCTAssertEqual(model.selectedSignatureIDs.count, 2)
        XCTAssertEqual(model.pendingSignatureIDs.count, 2)
        let ids = model.selectedSignatureIDs
        model.apply(SignatureDrawing(strokes: [[.zero, CGPoint(x: 30, y: 10)]]), to: ids)
        model.placeSignature(at: CGPoint(x: 500, y: 100), page: 1, pageSize: size)
        XCTAssertEqual(model.selectedSignatureIDs.count, 1)
        XCTAssertFalse(model.selection.contains(first.id))
        XCTAssertEqual(model.pendingSignatureIDs.count, 1)
        model.placeSignature(at: .zero, page: 0, pageSize: size)
        XCTAssertEqual(model.items.last?.rect.minX, 0)
        XCTAssertEqual(model.items.last?.rect.minY, 0)
        XCTAssertEqual(model.selectedSignatureIDs.count, 2)
    }

    func testConstrainResizedAndMovedBoxesToPage() {
        let size = CGSize(width: 200, height: 100)
        XCTAssertEqual(EditorModel.constrained(CGRect(x: -10, y: 99, width: 400, height: 0), to: size),
                       CGRect(x: 0, y: 92, width: 200, height: 8))
    }
}
