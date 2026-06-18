// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "VegaEar",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "VegaEar", targets: ["VegaEar"])
    ],
    dependencies: [
        .package(path: "../../packages/ear-protocol/swift"),
        .package(url: "https://github.com/microsoft/onnxruntime-swift-package-manager", exact: "1.20.0"),
        .package(url: "https://github.com/socketio/socket.io-client-swift", from: "16.1.1")
    ],
    targets: [
        .executableTarget(
            name: "VegaEar",
            dependencies: [
                .product(name: "EarProtocol", package: "swift"),
                .product(name: "onnxruntime", package: "onnxruntime-swift-package-manager"),
                .product(name: "SocketIO", package: "socket.io-client-swift")
            ],
            path: "Sources/VegaEar",
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "VegaEarTests",
            dependencies: ["VegaEar"],
            path: "Tests/VegaEarTests"
        )
    ]
)
