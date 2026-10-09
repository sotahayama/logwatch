import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

// 平文のトークンは戻り値でしか返さない(DBにはハッシュだけを保存する)
export async function registerHost(name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("端末名を指定してください。");
  const token = randomBytes(32).toString("base64url");
  const host = await prisma.host.create({
    data: { name: trimmed, tokenHash: hashToken(token) },
  });
  return { host, token };
}

export async function findHostByAuthorization(header: string | null) {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  return prisma.host.findUnique({ where: { tokenHash: hashToken(token) } });
}
