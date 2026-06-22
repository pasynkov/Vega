// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "EarCore",
    platforms: [
        .macOS(.v13),
        .iOS(.v17)
    ],
    products: [
        .library(name: "EarCore", targets: ["EarCore"])
    ],
    dependencies: [
        .package(path: "../ear-protocol/swift"),
        .package(url: "https://github.com/socketio/socket.io-client-swift", from: "16.1.1")
    ],
    targets: [
        .target(
            name: "EarCore",
            dependencies: [
                .product(name: "EarProtocol", package: "swift"),
                .product(name: "SocketIO", package: "socket.io-client-swift")
            ],
            path: "Sources/EarCore"
        ),
        .testTarget(
            name: "EarCoreTests",
            dependencies: ["EarCore"],
            path: "Tests/EarCoreTests"
        )
    ]
)
