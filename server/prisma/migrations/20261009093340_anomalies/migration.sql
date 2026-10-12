-- CreateEnum
CREATE TYPE "AnomalyKind" AS ENUM ('spike', 'silence');

-- CreateTable
CREATE TABLE "Anomaly" (
    "hostId" INTEGER NOT NULL,
    "minute" TIMESTAMP(3) NOT NULL,
    "process" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL,
    "kind" "AnomalyKind" NOT NULL,
    "count" INTEGER NOT NULL,
    "baseline" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Anomaly_pkey" PRIMARY KEY ("hostId","minute","process","level")
);

-- CreateIndex
CREATE INDEX "Anomaly_hostId_minute_idx" ON "Anomaly"("hostId", "minute");

-- AddForeignKey
ALTER TABLE "Anomaly" ADD CONSTRAINT "Anomaly_hostId_fkey" FOREIGN KEY ("hostId") REFERENCES "Host"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
