import Foundation
import LogWatchCore

let usage = """
    使い方: logwatch-agent [--endpoint <URL>] [--once] [--backfill <分>] [--checkpoint <パス>]

      --endpoint <URL>     集計を送るサーバーのURL(例: http://localhost:3000/api/ingest)。
                           トークンは環境変数 LOGWATCH_TOKEN で渡す。
                           省略すると NDJSON で標準出力に書き出す。
      --once               確定済みの分を1回だけ集計して終了する
      --backfill <分>      初回起動時に何分前から遡って集計するか(既定: 0)
      --checkpoint <パス>  どこまで送ったかを記録するファイル
    """

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n\n\(usage)\n".utf8))
    exit(2)
}

var once = false
var backfillMinutes = 0.0
var checkpointURL = FileCheckpointStore.defaultURL
var endpoint: URL?

var args = CommandLine.arguments.dropFirst()
while let arg = args.popFirst() {
    switch arg {
    case "--endpoint":
        guard let value = args.popFirst().flatMap(URL.init(string:)), value.scheme?.hasPrefix("http") == true else {
            fail("--endpoint には http(s) のURLを指定してください。")
        }
        endpoint = value
    case "--once":
        once = true
    case "--backfill":
        guard let value = args.popFirst().flatMap(Double.init), value >= 0 else {
            fail("--backfill には0以上の分数を指定してください。")
        }
        backfillMinutes = value
    case "--checkpoint":
        guard let path = args.popFirst() else { fail("--checkpoint にはパスを指定してください。") }
        checkpointURL = URL(filePath: path)
    case "-h", "--help":
        print(usage)
        exit(0)
    default:
        fail("不明なオプションです: \(arg)")
    }
}

let sink: CountSink
if let endpoint {
    // トークンを引数で渡すと ps などで他のユーザーから見えるため、環境変数から読む
    guard let token = ProcessInfo.processInfo.environment["LOGWATCH_TOKEN"], !token.isEmpty else {
        fail("--endpoint を使うときは環境変数 LOGWATCH_TOKEN にトークンを設定してください。")
    }
    sink = HTTPSink(endpoint: endpoint, token: token)
} else {
    sink = NDJSONSink()
}

let collector = Collector(
    reader: SystemLogReader(),
    sink: sink,
    checkpoint: FileCheckpointStore(url: checkpointURL)
)

func log(_ message: String) {
    FileHandle.standardError.write(Data("[logwatch-agent] \(message)\n".utf8))
}

@MainActor
func runCycle() async -> Bool {
    do {
        let counts = try await collector.runOnce(now: Date(), initialBackfill: backfillMinutes * 60)
        let minutes = Set(counts.map(\.minute)).count
        log("\(minutes)分ぶん・\(counts.count)件の集計を送りました")
        return true
    } catch {
        log("集計に失敗しました(次回再試行します): \(error)")
        return false
    }
}

if once {
    exit(await runCycle() ? 0 : 1)
}

while true {
    _ = await runCycle()
    // 次の分の区切りから、遅れて届くログを待つ時間だけ過ぎるまで眠る
    let now = Date()
    let next = now.minuteFloor.addingTimeInterval(60 + 5)
    try await Task.sleep(for: .seconds(next.timeIntervalSince(now)))
}
