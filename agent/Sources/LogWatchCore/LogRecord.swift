import Foundation

public enum LogLevel: String, Codable, Sendable, CaseIterable {
    case debug, info, notice, error, fault
}

// ログ本文は個人情報を含みうるため持たない。異常検知に使うのは「いつ・どのプロセスが・どの重要度で」だけ。
public struct LogRecord: Sendable, Equatable {
    public let date: Date
    public let process: String
    public let level: LogLevel

    public init(date: Date, process: String, level: LogLevel) {
        self.date = date
        self.process = process
        self.level = level
    }
}

public struct MinuteCount: Codable, Sendable, Hashable {
    public let minute: Date
    public let process: String
    public let level: LogLevel
    public let count: Int

    public init(minute: Date, process: String, level: LogLevel, count: Int) {
        self.minute = minute
        self.process = process
        self.level = level
        self.count = count
    }
}

extension Date {
    public var minuteFloor: Date {
        Date(timeIntervalSince1970: (timeIntervalSince1970 / 60).rounded(.down) * 60)
    }
}

public enum Aggregator {
    private struct Key: Hashable {
        let minute: Date
        let process: String
        let level: LogLevel
    }

    public static func countPerMinute(_ records: some Sequence<LogRecord>) -> [MinuteCount] {
        var counts: [Key: Int] = [:]
        for record in records {
            let key = Key(minute: record.date.minuteFloor, process: record.process, level: record.level)
            counts[key, default: 0] += 1
        }
        return counts
            .map { MinuteCount(minute: $0.key.minute, process: $0.key.process, level: $0.key.level, count: $0.value) }
            .sorted {
                ($0.minute, $0.process, $0.level.rawValue) < ($1.minute, $1.process, $1.level.rawValue)
            }
    }
}
