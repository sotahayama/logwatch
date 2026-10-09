import { NextResponse } from "next/server";
import { findHostByAuthorization } from "@/lib/hosts";
import { IngestError, parseCounts, storeCounts } from "@/lib/ingest";

export async function POST(req: Request) {
  const host = await findHostByAuthorization(req.headers.get("authorization"));
  if (!host) {
    return NextResponse.json({ error: "認証に失敗しました。" }, { status: 401 });
  }

  let counts;
  try {
    counts = parseCounts(await req.json());
  } catch (e) {
    if (e instanceof IngestError || e instanceof SyntaxError) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }

  await storeCounts(host.id, counts);
  return NextResponse.json({ stored: counts.length });
}
