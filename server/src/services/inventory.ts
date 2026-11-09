import type { Tx } from '../db.js';
import { prisma, dec } from '../db.js';
import { staffAlert } from './notify.js';

/** Deduct ingredients for a completed order exactly once (guarded by Order.inventoryApplied). */
export async function consumeInventory(tx: Tx, orderId: string) {
  const claimed = await tx.order.updateMany({ where: { id: orderId, inventoryApplied: false }, data: { inventoryApplied: true } });
  if (claimed.count === 0) return;
  const items = await tx.orderItem.findMany({ where: { orderId }, select: { productId: true, quantity: true } });
  const use = new Map<string, number>();
  for (const it of items) {
    const lines = await tx.recipeLine.findMany({ where: { productId: it.productId } });
    for (const l of lines) use.set(l.ingredientId, (use.get(l.ingredientId) ?? 0) + Number(l.quantity) * it.quantity);
  }
  for (const [ingredientId, qty] of use) {
    await tx.ingredient.update({ where: { id: ingredientId }, data: { stock: { decrement: dec(qty) } } });
    await tx.stockMovement.create({ data: { ingredientId, type: 'CONSUMPTION', quantity: dec(-qty), reference: orderId } });
  }
  if (use.size) setTimeout(() => void checkLowStock([...use.keys()]), 0);
}

export async function checkLowStock(ids?: string[]) {
  const low = await prisma.$queryRaw<Array<{ id: string; name: string; stock: any; reorderLevel: any; unit: string }>>`
    SELECT id, name, stock, "reorderLevel", unit FROM "Ingredient" WHERE stock <= "reorderLevel" AND "reorderLevel" > 0`;
  for (const i of low.filter((x) => !ids || ids.includes(x.id)))
    await staffAlert('low_stock', `Low stock: ${i.name} (${Number(i.stock)} ${i.unit} left)`);
  return low;
}
