// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PDFSigner",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "PDFSigner", targets: ["PDFSigner"])],
    targets: [
        .executableTarget(name: "PDFSigner"),
        .testTarget(name: "PDFSignerTests", dependencies: ["PDFSigner"]),
    ]
)
