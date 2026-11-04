-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('OPEN', 'PAID', 'VOID');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('NEW', 'RENEWAL', 'UPGRADE');

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "priceCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "intervalMonths" INTEGER NOT NULL DEFAULT 1,
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "limits" JSONB NOT NULL DEFAULT '{}',
    "features" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "pendingPlanId" TEXT,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "number" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'OPEN',
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubscriptionPayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "providerPaymentId" TEXT,
    "checkoutUrl" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" "PayAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "SubscriptionPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_tenantId_key" ON "Subscription"("tenantId");

-- CreateIndex
CREATE INDEX "Invoice_tenantId_createdAt_idx" ON "Invoice"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_subscriptionId_kind_periodStart_key" ON "Invoice"("subscriptionId", "kind", "periodStart");

-- CreateIndex
CREATE INDEX "SubscriptionPayment_invoiceId_idx" ON "SubscriptionPayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "SubscriptionPayment_provider_providerRef_key" ON "SubscriptionPayment"("provider", "providerRef");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_pendingPlanId_fkey" FOREIGN KEY ("pendingPlanId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubscriptionPayment" ADD CONSTRAINT "SubscriptionPayment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Default plans. Prices, limits and features are PLACEHOLDERS: the super admin edits them (Admin > Plans); nothing in code depends on these values.
INSERT INTO "Plan" (id, code, name, description, "priceCents", currency, "intervalMonths", "trialDays", limits, features, active, sort) VALUES
 (gen_random_uuid()::text, 'STARTER', 'Starter', 'Digital menu, QR ordering, basic ordering and analytics.', 49900, 'INR', 1, 14, '{"maxOutlets":1,"maxStaff":2,"maxProducts":60}'::jsonb, ARRAY[]::text[], true, 1),
 (gen_random_uuid()::text, 'GROWTH', 'Growth', 'Everything in Starter plus online payments, reservations, customer CRM, promotions and loyalty.', 99900, 'INR', 1, 14, '{"maxOutlets":1,"maxStaff":5,"maxProducts":null}'::jsonb, ARRAY['online_payments','reservations','crm','promotions','loyalty'], true, 2),
 (gen_random_uuid()::text, 'PRO', 'Pro', 'Everything in Growth plus inventory, unlimited staff and marketing campaigns.', 199900, 'INR', 1, 14, '{"maxOutlets":1,"maxStaff":null,"maxProducts":null}'::jsonb, ARRAY['online_payments','reservations','crm','promotions','loyalty','inventory','marketing'], true, 3),
 (gen_random_uuid()::text, 'ENTERPRISE', 'Enterprise', 'Everything in Pro plus multiple outlets.', 499900, 'INR', 1, 14, '{"maxOutlets":10,"maxStaff":null,"maxProducts":null}'::jsonb, ARRAY['online_payments','reservations','crm','promotions','loyalty','inventory','marketing','multi_outlet'], true, 4)
ON CONFLICT (code) DO NOTHING;

-- Businesses that existed before subscriptions are grandfathered: active for a year on the plan recorded in Tenant.plan (Starter if unknown).
INSERT INTO "Subscription" (id, "tenantId", "planId", status, "currentPeriodStart", "currentPeriodEnd", "updatedAt")
SELECT gen_random_uuid()::text, t.id, COALESCE((SELECT p.id FROM "Plan" p WHERE p.code = t.plan), (SELECT p.id FROM "Plan" p WHERE p.code = 'STARTER')),
       'ACTIVE', now(), now() + interval '365 days', now()
FROM "Tenant" t WHERE NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."tenantId" = t.id);
