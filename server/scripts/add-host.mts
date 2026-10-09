import "dotenv/config";
import { registerHost } from "@/lib/hosts";
import { prisma } from "@/lib/prisma";

const name = process.argv[2];
if (!name) {
  console.error("使い方: npm run host:add -- <端末名>");
  process.exit(2);
}

try {
  const { host, token } = await registerHost(name);
  console.log(`端末「${host.name}」(id=${host.id})を登録しました。`);
  console.log("エージェント用トークン(この画面でしか表示されません):");
  console.log(token);
} finally {
  await prisma.$disconnect();
}
