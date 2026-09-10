import type { ActionType, PendingAction, Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { config } from '@/config/index.js';

export interface CreatePendingActionInput {
  actorId: string;
  actorName: string;
  actionType: ActionType;
  payload: Prisma.InputJsonValue;
}

export const pendingActionRepository = {
  async create(data: CreatePendingActionInput): Promise<PendingAction> {
    const expiresAt = new Date(
      Date.now() + config.app.pendingActionTtlMinutes * 60 * 1000,
    );
    return prisma.pendingAction.create({ data: { ...data, expiresAt } });
  },

  async findByMessageId(discordMsgId: string): Promise<PendingAction | null> {
    return prisma.pendingAction.findUnique({ where: { discordMsgId } });
  },

  async findById(id: string): Promise<PendingAction | null> {
    return prisma.pendingAction.findUnique({ where: { id } });
  },

  async updateDiscordMsgId(id: string, discordMsgId: string): Promise<void> {
    await prisma.pendingAction.update({ where: { id }, data: { discordMsgId } });
  },

  async deleteById(id: string): Promise<void> {
    await prisma.pendingAction.delete({ where: { id } }).catch(() => {
      // Already deleted — ignore
    });
  },

  async purgeExpired(): Promise<number> {
    const result = await prisma.pendingAction.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return result.count;
  },
};
