"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 表示中の画面を保ったまま、サーバーから最新のデータを取り直す
export function AutoRefresh({ intervalMs }: { intervalMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);
  return null;
}
