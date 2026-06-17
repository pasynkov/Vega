// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "EarProtocol",
    platforms: [
        .macOS(.v13),
        .iOS(.v15)
    ],
    products: [
        .library(name: "EarProtocol", targets: ["EarProtocol"])
    ],
    targets: [
        .target(
            name: "EarProtocol",
            path: "Sources/EarProtocol"
        ),
        .testTarget(
            name: "EarProtocolTests",
            dependencies: ["EarProtocol"],
            path: "Tests/EarProtocolTests",
            resources: [
                .copy("Fixtures/examples.json")
            ]
        )
    ]
)
