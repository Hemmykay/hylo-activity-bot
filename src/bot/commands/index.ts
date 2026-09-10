import type { AutocompleteInteraction, ChatInputCommandInteraction } from 'discord.js';

// Accepts any discord.js builder — all of them have name + toJSON()
export interface SlashCommand {
  data: { name: string; toJSON(): unknown };
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  autocomplete?(interaction: AutocompleteInteraction): Promise<void>;
}

import * as followup1 from './followup1.js';
import * as followup2 from './followup2.js';
import * as rewrite from './rewrite.js';
import * as paraphrase from './paraphrase.js';
import * as friendly from './friendly.js';
import * as professional from './professional.js';
import * as shorten from './shorten.js';
import * as faq from './faq/index.js';
import * as venue from './venue/index.js';
import * as asset from './asset/index.js';
import * as corrections from './corrections/index.js';
import * as customerSupport from './customer-support.js';
import * as ehyusdCap from './ehyusd-cap.js';

export const commands = new Map<string, SlashCommand>([
  ['followup1', followup1 as SlashCommand],
  ['followup2', followup2 as SlashCommand],
  ['rewrite', rewrite as SlashCommand],
  ['paraphrase', paraphrase as SlashCommand],
  ['friendly', friendly as SlashCommand],
  ['professional', professional as SlashCommand],
  ['shorten', shorten as SlashCommand],
  ['customer-support', customerSupport as SlashCommand],
  ['faq', faq as SlashCommand],
  ['venue', venue as SlashCommand],
  ['asset', asset as SlashCommand],
  ['corrections', corrections as SlashCommand],
  ['ehyusd-cap', ehyusdCap as SlashCommand],
]);
