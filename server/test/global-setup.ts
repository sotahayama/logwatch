import { execSync } from "node:child_process";
import { TEST_DATABASE_URL } from "./database-url";

// 開発用とは別の logwatch_test にマイグレーションを当ててからテストする
export default function setup() {
  execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "ignore",
  });
}
