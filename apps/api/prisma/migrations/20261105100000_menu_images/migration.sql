-- CreateTable
CREATE TABLE "MenuImage" (
    "id" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MenuImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MenuImage_restaurantId_idx" ON "MenuImage"("restaurantId");

-- AddForeignKey
ALTER TABLE "MenuImage" ADD CONSTRAINT "MenuImage_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
