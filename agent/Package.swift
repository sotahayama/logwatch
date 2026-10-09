// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "logwatch-agent",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "logwatch-agent", targets: ["logwatch-agent"]),
        .library(name: "LogWatchCore", targets: ["LogWatchCore"]),
    ],
    targets: [
        .target(name: "LogWatchCore"),
        .executableTarget(name: "logwatch-agent", dependencies: ["LogWatchCore"]),
        .testTarget(name: "LogWatchCoreTests", dependencies: ["LogWatchCore"]),
    ]
)
