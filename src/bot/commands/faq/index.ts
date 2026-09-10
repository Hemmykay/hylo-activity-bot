import {
  ActionRowBuilder,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { faqService } from '@/services/faq/faq.service.js';
import { faqRepository } from '@/db/repositories/faq.repository.js';
import { searchService } from '@/services/search/search.service.js';
import { aiService } from '@/services/ai/ai.service.js';
import { buildFAQAuditPrompt, type FAQAuditResult } from '@/prompts/faq-improvement.js';
import {
  assertAuthorizedInteraction,
  replyWithError,
  COLORS,
  truncate,
  infoEmbed,
  buildConfirmationRow,
} from '@/lib/discord-utils.js';
import type { FAQ } from '@prisma/client';

export const data = new SlashCommandBuilder()
  .setName('faq')
  .setDescription('FAQ knowledge base commands')
  .addSubcommand((sub) =>
    sub
      .setName('search')
      .setDescription('Search the FAQ knowledge base')
      .addStringOption((opt) =>
        opt.setName('query').setDescription('What to search for').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('List all FAQs, optionally filtered by category')
      .addStringOption((opt) =>
        opt.setName('category').setDescription('Filter by category').setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName('categories').setDescription('List all FAQ categories'))
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Edit an existing FAQ')
      .addStringOption((opt) =>
        opt
          .setName('id')
          .setDescription('Start typing to search FAQs by title, category, or question')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Delete an existing FAQ')
      .addStringOption((opt) =>
        opt
          .setName('id')
          .setDescription('Start typing to search FAQs by title, category, or question')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('view')
      .setDescription('View full details of a specific FAQ')
      .addStringOption((opt) =>
        opt
          .setName('id')
          .setDescription('Start typing to search FAQs — leave blank to list all')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('audit')
      .setDescription('AI-powered audit: find FAQs to consolidate or improve'),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);

  const sub = interaction.options.getSubcommand(true);

  // edit opens a modal — cannot defer first
  if (sub === 'edit') {
    try {
      await handleEdit(interaction);
    } catch (err) {
      await replyWithError(interaction, err);
    }
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    if (sub === 'search') {
      await handleSearch(interaction);
    } else if (sub === 'list') {
      await handleList(interaction);
    } else if (sub === 'categories') {
      await handleCategories(interaction);
    } else if (sub === 'delete') {
      await handleDelete(interaction);
    } else if (sub === 'view') {
      await handleView(interaction);
    } else if (sub === 'audit') {
      await handleAudit(interaction);
    }
  } catch (err) {
    await replyWithError(interaction, err);
  }
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  if (sub !== 'edit' && sub !== 'delete' && sub !== 'view') {
    await interaction.respond([]);
    return;
  }

  const query = interaction.options.getFocused();
  const faqs = await faqRepository.searchForAutocomplete(query);

  const choices = faqs.map((faq) => {
    // Show: [Category] Title — question preview (max 100 chars total)
    const prefix = `[${faq.category}] ${faq.title}`;
    const questionPreview = faq.question.length > 0
      ? ` — ${faq.question}`
      : '';
    const full = prefix + questionPreview;
    const name = full.length > 100 ? full.slice(0, 99) + '…' : full;
    return { name, value: faq.id.slice(-6) };
  });

  await interaction.respond(choices);
}

// ─── Subcommand handlers ──────────────────────────────────────────────────────

async function handleEdit(interaction: ChatInputCommandInteraction): Promise<void> {
  const shortId = interaction.options.getString('id', true).trim();
  const faq = await faqRepository.findByShortId(shortId);

  if (!faq) {
    await interaction.reply({
      content: `No FAQ found with ID ending in \`${shortId}\`. Use \`/faq list\` to see IDs.`,
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`faq-live-edit-modal:${faq.id}`)
    .setTitle('Edit FAQ');

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title')
        .setStyle(TextInputStyle.Short)
        .setValue(faq.title)
        .setMaxLength(60)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('category')
        .setLabel('Category')
        .setStyle(TextInputStyle.Short)
        .setValue(faq.category)
        .setMaxLength(80)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('tags')
        .setLabel('Tags (comma-separated)')
        .setStyle(TextInputStyle.Short)
        .setValue(faq.tags.join(', '))
        .setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('question')
        .setLabel('Question')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(faq.question)
        .setMaxLength(500)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('answer')
        .setLabel('Answer (Markdown supported)')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(faq.answer.slice(0, 4000))
        .setMaxLength(4000)
        .setRequired(true),
    ),
  );

  await interaction.showModal(modal);
}

async function handleDelete(interaction: ChatInputCommandInteraction): Promise<void> {
  const shortId = interaction.options.getString('id', true).trim();
  const faq = await faqRepository.findByShortId(shortId);

  if (!faq) {
    await interaction.editReply({
      content: `No FAQ found with ID ending in \`${shortId}\`. Use \`/faq list\` to see IDs.`,
    });
    return;
  }

  const actor = { id: interaction.user.id, name: interaction.user.displayName };
  const pendingId = await faqService.pendingDelete(faq.id, actor, interaction.channelId);

  const embed = new EmbedBuilder()
    .setColor(COLORS.error)
    .setTitle('🗑️ Delete FAQ?')
    .addFields(
      { name: 'Title', value: faq.title, inline: false },
      { name: 'Category', value: faq.category, inline: true },
      { name: 'ID', value: `\`${faq.id.slice(-6)}\``, inline: true },
      { name: 'Question', value: truncate(faq.question, 300), inline: false },
    )
    .setFooter({ text: 'This will soft-delete the FAQ (recoverable by an admin)' })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [buildConfirmationRow(pendingId)] });
}

async function handleSearch(interaction: ChatInputCommandInteraction) {
  const query = interaction.options.getString('query', true);
  const results = await searchService.search(query, interaction.user.id);

  if (results.length === 0) {
    await interaction.editReply({
      embeds: [infoEmbed('No Results', `No FAQs matched **${query}**. Try different keywords.`)],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`FAQ Search: "${query}"`)
    .setDescription(`Found **${results.length}** result${results.length === 1 ? '' : 's'}`)
    .setTimestamp();

  for (const result of results.slice(0, 5)) {
    embed.addFields({
      name: `${result.title} · [${result.category}] · \`${result.id.slice(-6)}\``,
      value: truncate(result.answer.replace(/#{1,6}\s/g, '').replace(/\*\*/g, ''), 300),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const catArg = interaction.options.getString('category');
  const faqs = await faqService.listAll(catArg ? { category: catArg } : {});

  if (faqs.length === 0) {
    const msg = catArg ? `No FAQs in category **${catArg}**.` : 'The FAQ database is empty.';
    await interaction.editReply({ embeds: [infoEmbed('No FAQs', msg)] });
    return;
  }

  const grouped = faqs.reduce<Record<string, FAQ[]>>((acc, faq) => {
    (acc[faq.category] ??= []).push(faq);
    return acc;
  }, {});

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(catArg ? `FAQs — ${catArg}` : 'All FAQs')
    .setDescription(`**${faqs.length}** FAQ${faqs.length === 1 ? '' : 's'} total — use the 6-char ID with \`/faq edit\` or \`/faq delete\``)
    .setTimestamp();

  for (const [cat, entries] of Object.entries(grouped)) {
    embed.addFields({
      name: `📂 ${cat}`,
      value: entries.map((f) => `• ${f.title} \`${f.id.slice(-6)}\``).join('\n'),
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function handleCategories(interaction: ChatInputCommandInteraction) {
  const categories = await faqService.getCategories();

  if (categories.length === 0) {
    await interaction.editReply({ embeds: [infoEmbed('No Categories', 'No FAQs exist yet.')] });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('FAQ Categories')
    .setDescription(categories.map((c) => `• ${c}`).join('\n'))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleView(interaction: ChatInputCommandInteraction) {
  const shortId = interaction.options.getString('id');

  if (shortId) {
    const faq = await faqRepository.findByShortId(shortId.trim());
    if (!faq) {
      await interaction.editReply({
        content: `No FAQ found with ID ending in \`${shortId}\`. Use \`/faq list\` to see IDs.`,
      });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(faq.title)
      .addFields(
        { name: 'Category', value: faq.category, inline: true },
        { name: 'ID', value: `\`${faq.id.slice(-6)}\``, inline: true },
        { name: 'Tags', value: faq.tags.join(', ') || 'none', inline: true },
        { name: 'Question', value: faq.question, inline: false },
        { name: 'Answer', value: truncate(faq.answer, 1000), inline: false },
      )
      .setFooter({ text: `Last updated` })
      .setTimestamp(faq.updatedAt);
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // No ID provided — same as /faq list
  const faqs = await faqService.listAll({});
  if (faqs.length === 0) {
    await interaction.editReply({ embeds: [infoEmbed('No FAQs', 'The FAQ database is empty.')] });
    return;
  }
  const grouped = faqs.reduce<Record<string, FAQ[]>>((acc, faq) => {
    (acc[faq.category] ??= []).push(faq);
    return acc;
  }, {});
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('All FAQs')
    .setDescription(`**${faqs.length}** FAQ${faqs.length === 1 ? '' : 's'} — use a 6-char ID with \`/faq view [id]\` to see full details`)
    .setTimestamp();
  for (const [cat, entries] of Object.entries(grouped)) {
    embed.addFields({
      name: `📂 ${cat}`,
      value: entries.map((f) => `• ${f.title} \`${f.id.slice(-6)}\``).join('\n'),
      inline: false,
    });
  }
  await interaction.editReply({ embeds: [embed] });
}

async function handleAudit(interaction: ChatInputCommandInteraction) {
  await interaction.editReply({ content: 'Analyzing your FAQ database... this may take a moment.' });

  const faqs = await faqService.listAll({});
  if (faqs.length < 2) {
    await interaction.editReply({ embeds: [infoEmbed('Nothing to Audit', 'Add more FAQs before running an audit.')] });
    return;
  }

  const aiResponse = await aiService.generate(
    buildFAQAuditPrompt({
      faqs: faqs.map((f) => ({
        id: f.id,
        title: f.title,
        category: f.category,
        question: f.question,
        answer: f.answer,
      })),
    }),
  );

  let audit: FAQAuditResult;
  try {
    const cleaned = aiResponse.text
      .trim()
      .replace(/^```(?:json)?\n?/m, '')
      .replace(/\n?```$/m, '');
    audit = JSON.parse(cleaned) as FAQAuditResult;
  } catch {
    await interaction.editReply({ content: 'Audit complete, but I had trouble formatting the results. Try again.' });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('FAQ Knowledge Base Audit')
    .setDescription(audit.summary)
    .setTimestamp();

  if (audit.consolidations.length > 0) {
    for (const c of audit.consolidations) {
      embed.addFields({
        name: `Merge: "${c.primaryTitle}" + "${c.duplicateTitle}"`,
        value: [
          `**Why:** ${c.reason}`,
          `**Proposed title:** ${c.mergedTitle}`,
          `**IDs:** \`${c.primaryId}\` (keep) + \`${c.duplicateId}\` (fold in)`,
          `Use \`/faq edit\` to update \`${c.primaryId}\`, then \`/faq delete\` to remove \`${c.duplicateId}\``,
        ].join('\n'),
        inline: false,
      });
    }
  }

  if (audit.improvements.length > 0) {
    for (const imp of audit.improvements) {
      embed.addFields({
        name: `Improve: "${imp.faqTitle}" (\`${imp.faqId}\`)`,
        value: `**Issue:** ${imp.issue}\n**Suggestion:** ${imp.suggestion}`,
        inline: false,
      });
    }
  }

  if (audit.consolidations.length === 0 && audit.improvements.length === 0) {
    embed.addFields({ name: 'Result', value: 'No issues found — the knowledge base looks clean!', inline: false });
  }

  await interaction.editReply({ content: '', embeds: [embed] });
}
