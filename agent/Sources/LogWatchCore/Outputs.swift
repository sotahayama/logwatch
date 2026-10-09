import Foundation

public struct NDJSONSink: CountSink {
    let write: @Sendable (String) -> Void

    public init(write: @escaping @Sendable (String) -> Void = { print($0) }) {
        self.write = write
    }

    public func send(_ counts: [MinuteCount]) async throws {
        let encoder = makeEncoder()
        for count in counts {
            write(String(decoding: try encoder.encode(count), as: UTF8.self))
        }
    }
}

func makeEncoder() -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = .sortedKeys
    return encoder
}

public struct HTTPSinkError: Error, CustomStringConvertible {
    public let statusCode: Int
    public let body: String
    public var description: String { "サーバーが \(statusCode) を返しました: \(body)" }
}

// サーバーは同じ分の再送を置き換えで保存するため、途中のまとまりで失敗しても全体を送り直してよい
public struct HTTPSink: CountSink {
    let endpoint: URL
    let token: String
    let session: URLSession
    let chunkSize: Int

    public init(endpoint: URL, token: String, session: URLSession = .shared, chunkSize: Int = 5000) {
        self.endpoint = endpoint
        self.token = token
        self.session = session
        self.chunkSize = chunkSize
    }

    private struct Payload: Encodable {
        let counts: [MinuteCount]
    }

    public func send(_ counts: [MinuteCount]) async throws {
        let encoder = makeEncoder()
        for start in stride(from: 0, to: counts.count, by: chunkSize) {
            let chunk = Array(counts[start..<min(start + chunkSize, counts.count)])
            var request = URLRequest(url: endpoint)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.httpBody = try encoder.encode(Payload(counts: chunk))

            let (data, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard (200..<300).contains(status) else {
                throw HTTPSinkError(statusCode: status, body: String(decoding: data, as: UTF8.self))
            }
        }
    }
}

public struct FileCheckpointStore: CheckpointStore {
    let url: URL

    public init(url: URL) {
        self.url = url
    }

    public static var defaultURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appending(path: "Library/Application Support/logwatch/checkpoint")
    }

    public func load() throws -> Date? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let text = try String(contentsOf: url, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        return ISO8601DateFormatter().date(from: text)
    }

    public func save(_ date: Date) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try ISO8601DateFormatter().string(from: date).write(to: url, atomically: true, encoding: .utf8)
    }
}
