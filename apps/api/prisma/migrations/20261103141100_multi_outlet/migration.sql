-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "restaurantId" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "maxOutlets" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "restaurantId" TEXT;

-- Existing non-owner staff become assigned to their tenant's first (oldest) restaurant,
-- so adding outlets later never silently widens their access.
UPDATE "User" u SET "restaurantId" = (
  SELECT r.id FROM "Restaurant" r WHERE r."tenantId" = u."tenantId" ORDER BY r."createdAt" ASC LIMIT 1
) WHERE u.role IN ('MANAGER', 'KITCHEN', 'WAITER') AND u."tenantId" IS NOT NULL;
