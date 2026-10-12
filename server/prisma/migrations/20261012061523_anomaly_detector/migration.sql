-- CreateEnum
CREATE TYPE "Detector" AS ENUM ('statistical', 'pca');

-- DropIndex
DROP INDEX "Anomaly_hostId_minute_idx";

-- AlterTable
ALTER TABLE "Anomaly" DROP CONSTRAINT "Anomaly_pkey",
ADD COLUMN     "detector" "Detector" NOT NULL DEFAULT 'statistical',
ADD CONSTRAINT "Anomaly_pkey" PRIMARY KEY ("hostId", "detector", "minute", "process", "level");

-- CreateIndex
CREATE INDEX "Anomaly_hostId_detector_minute_idx" ON "Anomaly"("hostId", "detector", "minute");

