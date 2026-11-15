-- CreateTable
CREATE TABLE "PushDeviceToken" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "deviceId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushDeviceToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PushDeviceToken_token_key" ON "PushDeviceToken"("token");

-- CreateIndex
CREATE INDEX "PushDeviceToken_ownerId_idx" ON "PushDeviceToken"("ownerId");

-- CreateIndex
CREATE INDEX "PushDeviceToken_deviceId_idx" ON "PushDeviceToken"("deviceId");

