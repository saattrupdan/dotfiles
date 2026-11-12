// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "file-protector",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "file-protector", targets: ["file-protector"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "file-protector",
            dependencies: []
        )
    ]
)
