// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "vm-runner",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "vm-runner", targets: ["vm-runner"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "vm-runner",
            dependencies: []
        )
    ]
)
