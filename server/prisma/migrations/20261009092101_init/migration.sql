-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('debug', 'info', 'notice', 'error', 'fault');

-- CreateTable
CREATE TABLE "Host" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Host_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MinuteCount" (
    "hostId" INTEGER NOT NULL,
    "minute" TIMESTAMP(3) NOT NULL,
    "process" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "count" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MinuteCount_pkey" PRIMARY KEY ("hostId","minute","process","level")
);

-- CreateIndex
CREATE UNIQUE INDEX "Host_name_key" ON "Host"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Host_tokenHash_key" ON "Host"("tokenHash");

-- CreateIndex
CREATE INDEX "MinuteCount_hostId_minute_idx" ON "MinuteCount"("hostId", "minute");

-- AddForeignKey
ALTER TABLE "MinuteCount" ADD CONSTRAINT "MinuteCount_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
