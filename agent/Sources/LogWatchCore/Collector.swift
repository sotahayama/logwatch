import Foundation

public protocol CountSink: Sendable {
    func send(_ counts: [MinuteCount]) async throws
}

public protocol CheckpointStore: Sendable {
    func load() throws -> Date?
    func save(_ date: Date) throws
}

public struct Collector: Sendable {
    let reader: LogReader
    let sink: CountSink
    let checkpoint: CheckpointStore
    /// 分の区切りを過ぎてから、遅れて記録されるログを待つ時間
    let settleDelay: TimeInterval
    /// 長く止まっていた場合に遡って読む上限
    let maxBackfill: TimeInterval

    public init(
        reader: LogReader,
        sink: CountSink,
        checkpoint: CheckpointStore,
        settleDelay: TimeInterval = 5,
        maxBackfill: TimeInterval = 3600
    ) {
        self.reader = reader
        self.sink = sink
        self.checkpoint = checkpoint
        self.settleDelay = settleDelay
        self.maxBackfill = maxBackfill
    }

    /// 前回送った時点から、確定した直前の分までを集計して送る。
    /// 送信に成功したときだけチェックポイントを進めるので、失敗した分は次回また送られる(取りこぼさない)。
    @discardableResult
    public func runOnce(now: Date, initialBackfill: TimeInterval = 0) async throws -> [MinuteCount] {
        let end = now.addingTimeInterval(-settleDelay).minuteFloor
        let saved = try checkpoint.load()
        // 上限は「長く止まっていた後の追いつき」のためのもの。初回に明示的に遡る指定はそのまま守る
        let limit = saved == nil ? max(maxBackfill, initialBackfill) : maxBackfill
        let earliest = now.addingTimeInterval(-limit).minuteFloor
        let start = max(saved ?? end.addingTimeInterval(-initialBackfill).minuteFloor, earliest)
        guard start < end else {
            try checkpoint.save(max(start, end))
            return []
        }

        let counts = Aggregator.countPerMinute(try reader.records(from: start, to: end))
        try await sink.send(counts)
        try checkpoint.save(end)
        return counts
    }
}
