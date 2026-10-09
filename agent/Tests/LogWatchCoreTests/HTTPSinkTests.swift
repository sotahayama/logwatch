import Foundation
import Testing
@testable import LogWatchCore

// 実際の通信はせず、URLSession が送ろうとしたリクエストを横取りして記録する
private final class StubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var statusCode = 200
    nonisolated(unsafe) static var requests: [(request: URLRequest, body: Data)] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append((request, Self.readBody(request)))
        let response = HTTPURLResponse(
            url: request.url!, statusCode: Self.statusCode, httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"error":"stub"}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    // URLProtocol に渡るリクエストでは本文が httpBodyStream に移されている
    private static func readBody(_ request: URLRequest) -> Data {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return Data() }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}

private func makeSink(chunkSize: Int = 5000) -> HTTPSink {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubURLProtocol.self]
    return HTTPSink(
        endpoint: URL(string: "http://localhost:3000/api/ingest")!,
        token: "secret-token",
        session: URLSession(configuration: config),
        chunkSize: chunkSize
    )
}

private func counts(_ n: Int) -> [MinuteCount] {
    (0..<n).map {
        MinuteCount(
            minute: Date(timeIntervalSince1970: 1_791_536_400), process: "p\($0)", level: .notice, count: 1)
    }
}

private struct Payload: Decodable {
    struct Count: Decodable {
        let minute: String
        let process: String
        let level: String
        let count: Int
    }
    let counts: [Count]
}

@Suite("サーバーへの送信", .serialized)
struct HTTPSinkTests {
    init() {
        StubURLProtocol.statusCode = 200
        StubURLProtocol.requests = []
    }

    @Test("トークン付きのPOSTで、counts配列をJSONで送る")
    func postsCountsWithBearerToken() async throws {
        try await makeSink().send(counts(2))

        let (request, body) = try #require(StubURLProtocol.requests.first)
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer secret-token")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")

        let payload = try JSONDecoder().decode(Payload.self, from: body)
        #expect(payload.counts.map(\.process) == ["p0", "p1"])
        #expect(payload.counts.first?.minute == "2026-10-09T09:00:00Z")
    }

    @Test("件数が多いときは分割して送る")
    func splitsIntoChunks() async throws {
        try await makeSink(chunkSize: 2).send(counts(5))

        let sizes = try StubURLProtocol.requests.map {
            try JSONDecoder().decode(Payload.self, from: $0.body).counts.count
        }
        #expect(sizes == [2, 2, 1])
    }

    @Test("サーバーが失敗を返したらエラーにする(チェックポイントを進めさせない)")
    func throwsOnServerError() async throws {
        StubURLProtocol.statusCode = 401

        await #expect(throws: HTTPSinkError.self) { try await makeSink().send(counts(1)) }
    }

    @Test("送るものがなければ通信しない")
    func skipsEmpty() async throws {
        try await makeSink().send([])
        #expect(StubURLProtocol.requests.isEmpty)
    }
}
