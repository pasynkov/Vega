// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "EarUI",
    platforms: [
        .macOS(.v13),
        .iOS(.v17)
    ],
    products: [
        .library(name: "EarUI", targets: ["EarUI"])
    ],
    dependencies: [
        .package(path: "../ear-protocol/swift"),
        .package(path: "../ear-core")
    ],
    targets: [
        .target(
            name: "EarUI",
            dependencies: [
                .product(name: "EarProtocol", package: "swift"),
                .product(name: "EarCore", package: "ear-core")
            ],
            path: "Sources/EarUI",
            resources: [
                .process("Resources")
            ]
        ),
        .testTarget(
            name: "EarUITests",
            dependencies: ["EarUI"],
            path: "Tests/EarUITests"
        )
    ]
)
