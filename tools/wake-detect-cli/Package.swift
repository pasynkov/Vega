// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "wake-detect-cli",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "wake-detect", targets: ["WakeDetect"])
    ],
    dependencies: [
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager", exact: "1.24.2"),
    ],
    targets: [
        .executableTarget(
            name: "WakeDetect",
            dependencies: [
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager"),
            ],
            path: "Sources/WakeDetect"
        )
    ]
)
