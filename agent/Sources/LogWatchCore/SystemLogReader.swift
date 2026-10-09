import Foundation
import OSLog

public protocol LogReader: Sendable {
    /// [start, end) に記録されたログを返す
    func records(from start: Date, to end: Date) throws -> [LogRecord]
}

// OSLogStore.local() は管理者ユーザーで実行する必要がある
public struct SystemLogReader: LogReader {
    public init() {}

    public func records(from start: Date, to end: Date) throws -> [LogRecord] {
        let store = try OSLogStore.local()
        let entries = try store.getEntries(at: store.position(date: start))
        var result: [LogRecord] = []
        for case let entry as OSLogEntryLog in entries {
            guard entry.date >= start, entry.date < end else { continue }
            result.append(LogRecord(date: entry.date, process: entry.process, level: LogLevel(entry.level)))
        }
        return result
    }
}

extension LogLevel {
    init(_ level: OSLogEntryLog.Level) {
        switch level {
        case .debug: self = .debug
        case .info: self = .info
        case .error: self = .error
        case .fault: self = .fault
        case .notice, .undefined: self = .notice
        @unknown default: self = .notice
        }
    }
}
