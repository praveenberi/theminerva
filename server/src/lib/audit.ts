import type { Request } from 'express';
import { prisma } from '../db.js';
import { logger } from './logger.js';

export async function audit(req: Request | null, action: string, entity?: string, entityId?: string, detail?: object) {
  try {
    await prisma.auditLog.create({
      data: { userId: req?.staff?.id, action, entity, entityId, detail: detail as any, ip: req?.ip },
    });
  } catch (e) {
    logger.error({ err: e }, 'audit write failed');
  }
}
