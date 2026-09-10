import { type Message } from 'discord.js';
import { routeIntent } from './intent-router.js';
import { assertAuthorizedDM } from '@/lib/discord-utils.js';
import { isAppError } from '@/lib/errors.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('dm-handler');

// ─── Processing State Machine ─────────────────────────────────────────────────
// Every message starts processing immediately — no artificial delay.
//
// If a new message arrives from the same user WHILE the bot is still processing:
//
//   Related topic  → Supersede: the in-flight job is silently discarded via a
//                    generation counter. The new job starts with merged context.
//
//   Unrelated topic → Queue: let the first job complete and reply, then start
//                    the queued job immediately after.
//
// "Related" heuristic: a short message with no "?" is almost always a casual
// remark or continuation. Two messages that both contain explicit questions are
// treated as separate topics.

interface UserState {
  generation: number;
  isProcessing: boolean;
  currentContent: string;
  queue: Array<{ content: string; message: Message }>;
}

const userStates = new Map<string, UserState>();

function isRelated(existing: string, incoming: string): boolean {
  const incomingIsShortCasual = incoming.trim().length < 80 && !incoming.includes('?');
  if (incomingIsShortCasual) return true; // e.g. "Alright", "Thanks", follow-up remarks

  // Two explicit questions are likely separate topics
  if (existing.includes('?') && incoming.includes('?')) return false;

  return true; // default: treat as related
}

function mergeContent(existing: string, incoming: string): string {
  // If the existing message was just noise (short, no question), drop it and
  // use only the new message as the real query
  const existingWasNoise = existing.trim().length < 60 && !existing.includes('?');
  return existingWasNoise ? incoming : `${existing}\n\n${incoming}`;
}

async function processJob(
  message: Message,
  content: string,
  userId: string,
  generation: number,
): Promise<void> {
  const guard = { isCancelled: () => (userStates.get(userId)?.generation ?? -1) !== generation };

  try {
    await routeIntent(message, content, guard);
  } catch (err) {
    if (!guard.isCancelled()) {
      logger.error({ err }, 'DM processing error');
      await message.reply('Something went wrong processing your message. Please try again.').catch(() => {});
    }
  } finally {
    const state = userStates.get(userId);
    if (state && state.generation === generation) {
      // We are still the active generation — check the queue
      const next = state.queue.shift();
      if (next) {
        state.currentContent = next.content;
        state.generation++;
        void processJob(next.message, next.content, userId, state.generation);
      } else {
        state.isProcessing = false;
      }
    }
    // If generation doesn't match, we were superseded — do nothing.
  }
}

export async function handleDM(message: Message): Promise<void> {
  try {
    await assertAuthorizedDM(message.client, message.author.id);
  } catch (err) {
    const reply = isAppError(err) ? err.message : 'You are not authorised to use this assistant.';
    await message.reply(reply).catch(() => {});
    return;
  }

  const content = message.content.trim();
  if (!content) {
    await message.reply('I received your message but it appears to be empty. Please include text.');
    return;
  }

  logger.debug({ userId: message.author.id, contentLength: content.length }, 'DM received');

  const userId = message.author.id;

  // FAQ creation and explicit replies bypass the state machine — they are
  // intentional standalone actions that should never be merged or superseded.
  const isFAQCreate = content.startsWith('!');
  const isExplicitReply = !!message.reference?.messageId;

  if (isFAQCreate || isExplicitReply) {
    const guard = { isCancelled: () => false }; // never cancelled
    try {
      await routeIntent(message, content, guard);
    } catch (err) {
      logger.error({ err }, 'DM handler error');
      await message.reply('Something went wrong. Please try again.').catch(() => {});
    }
    return;
  }

  let state = userStates.get(userId);

  if (!state || !state.isProcessing) {
    // No active job — start processing immediately
    if (!state) {
      state = { generation: 0, isProcessing: false, currentContent: content, queue: [] };
      userStates.set(userId, state);
    }
    state.isProcessing = true;
    state.currentContent = content;
    state.generation++;

    if ('sendTyping' in message.channel) void message.channel.sendTyping();
    void processJob(message, content, userId, state.generation);
  } else {
    // Bot is still processing a prior message from this user
    if (isRelated(state.currentContent, content)) {
      // Related → supersede: merge content, bump generation to cancel in-flight job
      const merged = mergeContent(state.currentContent, content);
      state.currentContent = merged;
      state.generation++;

      logger.debug(
        { userId, merged: merged.slice(0, 80) },
        'Superseding in-flight job with merged content',
      );

      if ('sendTyping' in message.channel) void message.channel.sendTyping();
      void processJob(message, merged, userId, state.generation);
    } else {
      // Unrelated → queue: answer first question, then this one
      state.queue.push({ content, message });
      logger.debug({ userId, queueLength: state.queue.length }, 'Message queued (different topic)');
    }
  }
}
