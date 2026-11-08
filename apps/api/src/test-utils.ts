import { prisma } from "./db.js";

/**
 * Deletes disposable test users together with their wallet history.
 * Ledger tables are append-only at the database level; deletes are only allowed inside this transaction
 * via a transaction-local setting. Only ever call this with throw-away test users.
 */
export async function deleteTestUsers(emails: string[]) {
  const users = await prisma.user.findMany({ where: { email: { in: emails } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  await prisma.$transaction([
    prisma.$executeRaw`SELECT set_config('walletshop.allow_ledger_delete', 'on', true)`,
    prisma.ledgerEntry.deleteMany({ where: { OR: [{ account: { userId: { in: ids } } }, { transaction: { userId: { in: ids } } }] } }),
    prisma.walletTransaction.deleteMany({ where: { userId: { in: ids } } }),
    prisma.walletAccount.deleteMany({ where: { userId: { in: ids } } }),
    prisma.user.deleteMany({ where: { id: { in: ids } } }),
  ]);
}
