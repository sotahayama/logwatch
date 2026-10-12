// 評価用:標準入力の JSON に対して本番と同じ統計的検知を行い、結果を JSON で標準出力に書く
// 入力: { "targets": ["2026-10-12T05:00:00Z", ...], "rows": [{ "minute", "process", "level", "count" }, ...] }
import { detectMinutes } from "@/lib/detect";
import type { Level } from "@/lib/ingest";

type Input = {
  targets: string[];
  rows: { minute: string; process: string; level: Level; count: number }[];
};

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const input: Input = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const anomalies = detectMinutes(
  input.targets.map((t) => new Date(t)),
  input.rows.map((r) => ({ ...r, minute: new Date(r.minute) })),
);

process.stdout.write(
  JSON.stringify(anomalies.map((a) => ({ ...a, minute: a.minute.toISOString() }))),
);
