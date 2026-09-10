import type { FAQ, Prisma } from '@prisma/client';
import { faqRepository } from '@/db/repositories/faq.repository.js';
import { auditRepository } from '@/db/repositories/audit.repository.js';
import { pendingActionRepository } from '@/db/repositories/pending-action.repository.js';
import { NotFoundError } from '@/lib/errors.js';
import { createLogger } from '@/lib/logger.js';
import type { ActorInfo, FAQCreatePayload, FAQDeletePayload, FAQDraftInput, FAQUpdatePayload } from './faq.types.js';

const logger = createLogger('faq-service');

// Cast our typed payloads through unknown to satisfy Prisma's InputJsonValue
function toJson(v: unknown): Prisma.InputJsonValue {
  return v as unknown as Prisma.InputJsonValue;
}

class FAQService {
  // ─── Read operations ────────────────────────────────────────────────────────

  async getById(id: string): Promise<FAQ> {
    const faq = await faqRepository.findById(id);
    if (!faq) throw new NotFoundError('FAQ', id);
    return faq;
  }

  async listAll(options?: { category?: string | undefined }): Promise<FAQ[]> {
    const category = options?.category;
    return faqRepository.findAll(category ? { category, activeOnly: true } : { activeOnly: true });
  }

  async getCategories(): Promise<string[]> {
    return faqRepository.listCategories();
  }

  // ─── Pending action creation ────────────────────────────────────────────────

  async pendingCreate(draft: FAQDraftInput, actor: ActorInfo, channelId: string): Promise<string> {
    const payload: FAQCreatePayload = { channelId, draft };
    const pending = await pendingActionRepository.create({
      actorId: actor.id,
      actorName: actor.name,
      actionType: 'FAQ_CREATE',
      payload: toJson(payload),
    });
    logger.debug({ pendingId: pending.id }, 'Pending FAQ create created');
    return pending.id;
  }

  async pendingUpdate(
    faqId: string,
    changes: Partial<FAQDraftInput>,
    actor: ActorInfo,
    channelId: string,
  ): Promise<string> {
    await this.getById(faqId);
    const payload: FAQUpdatePayload = { channelId, faqId, changes };
    const pending = await pendingActionRepository.create({
      actorId: actor.id,
      actorName: actor.name,
      actionType: 'FAQ_UPDATE',
      payload: toJson(payload),
    });
    return pending.id;
  }

  async pendingDelete(faqId: string, actor: ActorInfo, channelId: string): Promise<string> {
    await this.getById(faqId);
    const payload: FAQDeletePayload = { channelId, faqId };
    const pending = await pendingActionRepository.create({
      actorId: actor.id,
      actorName: actor.name,
      actionType: 'FAQ_DELETE',
      payload: toJson(payload),
    });
    return pending.id;
  }

  async setPendingDiscordMsgId(pendingId: string, discordMsgId: string): Promise<void> {
    await pendingActionRepository.updateDiscordMsgId(pendingId, discordMsgId);
  }

  // ─── Commit confirmed actions ────────────────────────────────────────────────

  async executeConfirmed(
    pendingId: string,
    actor: ActorInfo,
  ): Promise<{ action: string; faqId: string }> {
    const pending = await pendingActionRepository.findById(pendingId);
    if (!pending) throw new NotFoundError('PendingAction', pendingId);

    if (pending.expiresAt < new Date()) {
      await pendingActionRepository.deleteById(pendingId);
      throw new Error('This confirmation has expired. Please run the command again.');
    }

    let faqId: string;
    let action: string;

    switch (pending.actionType) {
      case 'FAQ_CREATE': {
        const { draft } = pending.payload as unknown as FAQCreatePayload;
        const faq = await faqRepository.create(draft);
        await auditRepository.create({
          action: 'FAQ_CREATE',
          entityType: 'FAQ',
          entityId: faq.id,
          after: toJson(faq),
          actorId: actor.id,
          actorName: actor.name,
        });
        faqId = faq.id;
        action = 'created';
        logger.info({ faqId: faq.id, title: faq.title }, 'FAQ created');
        break;
      }

      case 'FAQ_UPDATE': {
        const { faqId: id, changes } = pending.payload as unknown as FAQUpdatePayload;
        const before = await faqRepository.findById(id);
        const faq = await faqRepository.update(id, changes);
        await auditRepository.create({
          action: 'FAQ_UPDATE',
          entityType: 'FAQ',
          entityId: faq.id,
          ...(before ? { before: toJson(before) } : {}),
          after: toJson(faq),
          actorId: actor.id,
          actorName: actor.name,
        });
        faqId = faq.id;
        action = 'updated';
        logger.info({ faqId: faq.id }, 'FAQ updated');
        break;
      }

      case 'FAQ_DELETE': {
        const { faqId: id } = pending.payload as unknown as FAQDeletePayload;
        const before = await faqRepository.findById(id);
        await faqRepository.softDelete(id);
        await auditRepository.create({
          action: 'FAQ_DELETE',
          entityType: 'FAQ',
          entityId: id,
          ...(before ? { before: toJson(before) } : {}),
          actorId: actor.id,
          actorName: actor.name,
        });
        faqId = id;
        action = 'deleted';
        logger.info({ faqId: id }, 'FAQ deleted');
        break;
      }

      default:
        throw new Error(`Action type ${String(pending.actionType)} is not handled by faqService`);
    }

    await pendingActionRepository.deleteById(pendingId);
    return { action, faqId };
  }

  async cancelPending(pendingId: string): Promise<void> {
    await pendingActionRepository.deleteById(pendingId);
  }

  async updatePendingDraft(pendingId: string, newDraft: FAQDraftInput): Promise<void> {
    const pending = await pendingActionRepository.findById(pendingId);
    if (!pending) throw new NotFoundError('PendingAction', pendingId);
    const oldPayload = pending.payload as unknown as FAQCreatePayload;
    const newPayload: FAQCreatePayload = { ...oldPayload, draft: newDraft };
    await pendingActionRepository.deleteById(pendingId);
    await pendingActionRepository.create({
      actorId: pending.actorId,
      actorName: pending.actorName,
      actionType: pending.actionType,
      payload: toJson(newPayload),
    });
  }
}

export const faqService = new FAQService();
