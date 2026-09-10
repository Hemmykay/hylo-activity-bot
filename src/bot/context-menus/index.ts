import type { ContextMenuCommandBuilder, MessageContextMenuCommandInteraction } from 'discord.js';

export interface ContextMenuCommand {
  data: ContextMenuCommandBuilder;
  execute(interaction: MessageContextMenuCommandInteraction): Promise<void>;
}

import * as replyWithAI from './reply-with-ai.js';
import * as findFAQ from './find-faq.js';
import * as rewrite from './rewrite.js';
import * as summarizeIssue from './summarize-issue.js';
import * as createFAQ from './create-faq.js';

export const contextMenus = new Map<string, ContextMenuCommand>([
  ['Reply with AI', replyWithAI],
  ['Find Matching FAQ', findFAQ],
  ['Rewrite', rewrite],
  ['Summarize Issue', summarizeIssue],
  ['Create FAQ', createFAQ],
]);
