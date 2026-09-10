import type { ActionType, AuditLog, Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';

export interface CreateAuditLogInput {
  action: ActionType;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue | undefined;
  after?: Prisma.InputJsonValue | undefined;
  actorId: string;
  actorName: string;
}

export const auditRepository = {
  async create(data: CreateAuditLogInput): Promise<AuditLog> {
    return prisma.auditLog.create({
      data: {
        action: data.action,
        entityType: data.entityType,
        entityId: data.entityId,
        ...(data.before !== undefined ? { before: data.before } : {}),
        ...(data.after !== undefined ? { after: data.after } : {}),
        actorId: data.actorId,
        actorName: data.actorName,
      },
    });
  },

  async findByEntity(entityType: string, entityId: string): Promise<AuditLog[]> {
    return prisma.auditLog.findMany({
      where: { entityType, entityId },
      orderBy: { createdAt: 'desc' },
    });
  },
};
