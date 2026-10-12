import Foundation
import Testing
@testable import LogWatchCore

private func time(_ hhmmss: String) -> Date {
    let formatter = ISO8601DateFormatter()
    if hhmmss.contains(".") {
        formatter.formatOptions.insert(.withFractionalSeconds)
    }
    return formatter.date(from: "2026-10-09T\(hhmmss)Z")!
}

private final class FakeReader: LogReader, @unchecked Sendable {
    var records: [LogRecord]
    var requestedRanges: [(Date, Date)] = []

    init(_ records: [LogRecord]) { self.records = records }

    func records(from start: Date, to end: Date) throws -> [LogRecord] {
        requestedRanges.append((start, end))
        return records.filter { $0.date >= start && $0.date < end }
    }
}

private struct SendFailed: Error {}

private final class FakeSink: CountSink, @unchecked Sendable {
    var sent: [[MinuteCount]] = []
    var failing = false

    func send(_ counts: [MinuteCount]) async throws {
        if failing { throw SendFailed() }
        sent.append(counts)
    }
}

private final class MemoryCheckpoint: CheckpointStore, @unchecked Sendable {
    var saved: Date?
    init(_ saved: Date? = nil) { self.saved = saved }
    func load() throws -> Date? { saved }
    func save(_ date: Date) throws { saved = date }
}

@Suite("1分ごとの集計")
struct AggregatorTests {
    @Test("プロセスと重要度ごとに、分単位で件数を数える")
    func countsPerMinuteProcessAndLevel() {
        let counts = Aggregator.countPerMinute([
            LogRecord(date: time("10:00:01"), process: "Finder", level: .notice),
            LogRecord(date: time("10:00:30"), process: "Finder", level: .notice),
            LogRecord(date: time("10:00:40"), process: "Finder", level: .error),
            LogRecord(date: time("10:00:59"), process: "Safari", level: .notice),
        ])

        #expect(counts == [
            MinuteCount(minute: time("10:00:00"), process: "Finder", level: .error, count: 1),
            MinuteCount(minute: time("10:00:00"), process: "Finder", level: .notice, count: 2),
            MinuteCount(minute: time("10:00:00"), process: "Safari", level: .notice, count: 1),
        ])
    }

    @Test("分の境目をまたぐログは別の分に数える")
    func splitsAtMinuteBoundary() {
        let counts = Aggregator.countPerMinute([
            LogRecord(date: time("10:00:59.999"), process: "Finder", level: .notice),
            LogRecord(date: time("10:01:00"), process: "Finder", level: .notice),
        ])
        #expect(counts.map(\.minute) == [time("10:00:00"), time("10:01:00")])
    }
}

@Suite("収集の進め方")
struct CollectorTests {
    @Test("初回はチェックポイントを記録するだけで、過去は遡らない")
    func firstRunOnlyRecordsCheckpoint() async throws {
        let reader = FakeReader([LogRecord(date: time("10:00:10"), process: "Finder", level: .notice)])
        let sink = FakeSink()
        let checkpoint = MemoryCheckpoint()
        let collector = Collector(reader: reader, sink: sink, checkpoint: checkpoint)

        let counts = try await collector.runOnce(now: time("10:01:10"))

        #expect(counts.isEmpty)
        #expect(sink.sent.isEmpty)
        #expect(checkpoint.saved == time("10:01:00"))
    }

    @Test("前回の続きから、確定した分までを送ってチェックポイントを進める")
    func sendsSettledMinutesSinceCheckpoint() async throws {
        let reader = FakeReader([
            LogRecord(date: time("10:00:10"), process: "Finder", level: .notice),
            LogRecord(date: time("10:01:10"), process: "Finder", level: .notice),
            LogRecord(date: time("10:02:01"), process: "Finder", level: .notice),
        ])
        let sink = FakeSink()
        let checkpoint = MemoryCheckpoint(time("10:00:00"))
        let collector = Collector(reader: reader, sink: sink, checkpoint: checkpoint)

        // 10:02:03 時点では、遅れて届くログを待つため 10:02 の分はまだ確定していない
        try await collector.runOnce(now: time("10:02:03"))

        #expect(sink.sent.flatMap { $0 }.map(\.minute) == [time("10:00:00")])
        #expect(checkpoint.saved == time("10:01:00"))
    }

    @Test("送信に失敗したらチェックポイントを進めず、次回同じ分を送り直す")
    func retriesSameMinutesAfterFailure() async throws {
        let reader = FakeReader([LogRecord(date: time("10:00:10"), process: "Finder", level: .error)])
        let sink = FakeSink()
        let checkpoint = MemoryCheckpoint(time("10:00:00"))
        let collector = Collector(reader: reader, sink: sink, checkpoint: checkpoint)

        sink.failing = true
        await #expect(throws: SendFailed.self) { try await collector.runOnce(now: time("10:01:10")) }
        #expect(checkpoint.saved == time("10:00:00"))

        sink.failing = false
        try await collector.runOnce(now: time("10:02:10"))
        #expect(sink.sent.flatMap { $0 }.map(\.minute) == [time("10:00:00")])
        #expect(checkpoint.saved == time("10:02:00"))
    }

    @Test("長く止まっていても、遡るのは上限の時間までにする")
    func capsBackfillAfterLongPause() async throws {
        let reader = FakeReader([])
        let checkpoint = MemoryCheckpoint(time("01:00:00"))
        let collector = Collector(
            reader: reader, sink: FakeSink(), checkpoint: checkpoint, maxBackfill: 3600)

        try await collector.runOnce(now: time("10:00:10"))

        #expect(reader.requestedRanges.first?.0 == time("09:00:00"))
    }

    @Test("初回に明示的に遡る指定は、追いつきの上限より長くても守る")
    func explicitInitialBackfillBeyondCap() async throws {
        let reader = FakeReader([])
        let collector = Collector(
            reader: reader, sink: FakeSink(), checkpoint: MemoryCheckpoint(), maxBackfill: 3600)

        try await collector.runOnce(now: time("10:00:10"), initialBackfill: 6 * 3600)

        #expect(reader.requestedRanges.first?.0 == time("04:00:00"))
    }

    @Test("初回に遡る分数を指定できる")
    func initialBackfill() async throws {
        let reader = FakeReader([LogRecord(date: time("09:55:30"), process: "Finder", level: .notice)])
        let sink = FakeSink()
        let collector = Collector(reader: reader, sink: sink, checkpoint: MemoryCheckpoint())

        try await collector.runOnce(now: time("10:00:10"), initialBackfill: 600)

        #expect(reader.requestedRanges.first?.0 == time("09:50:00"))
        #expect(sink.sent.flatMap { $0 }.count == 1)
    }
}

private final class Lines: @unchecked Sendable {
    var values: [String] = []
}

@Suite("出力")
struct OutputTests {
    @Test("1件1行のJSONで、ログ本文を含まない")
    func writesOneJSONObjectPerLine() async throws {
        let lines = Lines()
        let sink = NDJSONSink { lines.values.append($0) }

        try await sink.send([MinuteCount(minute: time("10:00:00"), process: "Finder", level: .error, count: 3)])

        #expect(lines.values == [#"{"count":3,"level":"error","minute":"2026-10-09T10:00:00Z","process":"Finder"}"#])
    }

    @Test("チェックポイントはファイルに保存して読み戻せる")
    func fileCheckpointRoundTrip() async throws {
        let url = FileManager.default.temporaryDirectory
            .appending(path: "logwatch-test-\(UUID().uuidString)/checkpoint")
        let store = FileCheckpointStore(url: url)
        #expect(try store.load() == nil)

        try store.save(time("10:01:00"))
        #expect(try store.load() == time("10:01:00"))
    }
}
