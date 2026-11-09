import type { Role } from '@prisma/client';

export const PERMISSIONS = [
  'settings.manage', 'integrations.manage', 'audit.view', 'staff.manage',
  'menu.manage', 'cms.manage',
  'orders.view', 'orders.create', 'orders.manage', 'kitchen.manage', 'delivery.update',
  'payments.process', 'payments.refund',
  'tables.manage', 'reservations.manage',
  'customers.view', 'customers.manage', 'marketing.manage',
  'inventory.manage', 'reports.view', 'ai.use',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const manager: Permission[] = PERMISSIONS.filter((p) => !['integrations.manage', 'settings.manage', 'audit.view'].includes(p)) as Permission[];

export const ROLE_PERMISSIONS: Record<Role, Permission[] | '*'> = {
  OWNER: '*',
  MANAGER: manager,
  KITCHEN: ['orders.view', 'kitchen.manage'],
  WAITER: ['orders.view', 'orders.create', 'tables.manage', 'reservations.manage', 'payments.process'],
  CASHIER: ['orders.view', 'orders.create', 'payments.process', 'payments.refund', 'customers.view'],
  DELIVERY: ['orders.view', 'delivery.update'],
};

export const can = (role: Role, perm: Permission) => {
  const p = ROLE_PERMISSIONS[role];
  return p === '*' || p.includes(perm);
};
export const permsFor = (role: Role): Permission[] => {
  const p = ROLE_PERMISSIONS[role];
  return p === '*' ? [...PERMISSIONS] : p;
};
