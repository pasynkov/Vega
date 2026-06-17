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
        .package(path: "../../packages/ear-protocol/swift")
    ],
    targets: [
        .binaryTarget(
            name: "PvPorcupine",
            path: "Vendor/PvPorcupine.xcframework"
        ),
        .executableTarget(
            name: "VegaEar",
            dependencies: [
                .product(name: "EarProtocol", package: "swift"),
                "PvPorcupine"
            ],
            path: "Sources/VegaEar",
            resources: [
                .process("Resources"),
                .copy("../../Vendor/PvModel/porcupine_params.pv")
            ]
        ),
        .testTarget(
            name: "VegaEarTests",
            dependencies: ["VegaEar"],
            path: "Tests/VegaEarTests"
        )
    ]
)
