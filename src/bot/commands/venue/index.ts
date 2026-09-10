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
import { venueRepository } from '@/db/repositories/venue.repository.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { venueAssetXPRepository } from '@/db/repositories/venue-asset-xp.repository.js';
import { assertAuthorizedInteraction, replyWithError, COLORS, infoEmbed } from '@/lib/discord-utils.js';
import type { Venue } from '@prisma/client';

export const data = new SlashCommandBuilder()
  .setName('venue')
  .setDescription('Manage supported third-party venues and their XP structures')
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a new third-party venue')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Name of the venue (e.g. Kamino Finance)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List all active third-party venues'))
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription("Edit an existing venue's description and asset XP rates")
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Start typing to search venues')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove a venue from the active list')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Start typing to search venues')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('details')
      .setDescription('Show full venue data exactly as stored in the database')
      .addStringOption((opt) =>
        opt
          .setName('name')
          .setDescription('Venue name — leave blank to show all venues')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName('xp')
      .setDescription('Manage per-asset XP rates for a venue')
      .addSubcommand((sub) =>
        sub
          .setName('set')
          .setDescription('Set or update the XP rate a venue offers for a Hylo asset')
          .addStringOption((opt) =>
            opt.setName('venue').setDescription('Start typing to search venues').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt.setName('asset').setDescription('Start typing to search assets').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt.setName('rate').setDescription('e.g. "5 XP per dollar per day"').setRequired(true),
          )
          .addStringOption((opt) =>
            opt.setName('notes').setDescription('Optional note (pool pairing, bonus conditions, etc.)').setRequired(false),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remove')
          .setDescription("Remove an asset's XP link from a venue")
          .addStringOption((opt) =>
            opt.setName('venue').setDescription('Start typing to search venues').setRequired(true).setAutocomplete(true),
          )
          .addStringOption((opt) =>
            opt.setName('asset').setDescription('Start typing to search assets').setRequired(true).setAutocomplete(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName('list')
          .setDescription('List all asset XP rates for a venue')
          .addStringOption((opt) =>
            opt.setName('venue').setDescription('Start typing to search venues').setRequired(true).setAutocomplete(true),
          ),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);

  // Check the group FIRST — "/venue remove" and "/venue xp remove" both resolve
  // getSubcommand() to 'remove'; only the group tells them apart.
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(true);

  if (group === 'xp') {
    await interaction.deferReply({ ephemeral: true });
    try {
      if (sub === 'set') await handleXPSet(interaction);
      else if (sub === 'remove') await handleXPRemove(interaction);
      else if (sub === 'list') await handleXPList(interaction);
    } catch (err) {
      await replyWithError(interaction, err);
    }
    return;
  }

  // add and edit both open modals — cannot defer first
  if (sub === 'add' || sub === 'edit') {
    try {
      if (sub === 'add') await handleAdd(interaction);
      else await handleEditModal(interaction);
    } catch (err) {
      await replyWithError(interaction, err);
    }
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    if (sub === 'list') await handleList(interaction);
    else if (sub === 'remove') await handleRemove(interaction);
    else if (sub === 'details') await handleDetails(interaction);
  } catch (err) {
    await replyWithError(interaction, err);
  }
}

// ─── Autocomplete ─────────────────────────────────────────────────────────────

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const group = interaction.options.getSubcommandGroup(false);

  if (group === 'xp') {
    const focused = interaction.options.getFocused(true);
    if (focused.name === 'venue') {
      const venues = await venueRepository.searchForAutocomplete(focused.value);
      await interaction.respond(venues.map((v) => ({ name: v.name, value: v.name })));
    } else if (focused.name === 'asset') {
      const assets = await assetRepository.searchForAutocomplete(focused.value);
      await interaction.respond(assets.map((a) => ({ name: `${a.symbol} — ${a.name}`, value: a.symbol })));
    } else {
      await interaction.respond([]);
    }
    return;
  }

  const sub = interaction.options.getSubcommand(false);
  if (sub !== 'edit' && sub !== 'remove' && sub !== 'details') {
    await interaction.respond([]);
    return;
  }

  const query = interaction.options.getFocused();
  const venues = await venueRepository.searchForAutocomplete(query);

  const choices = venues.map((v) => {
    const description = v.description ? ` · ${v.description}` : '';
    const full = `${v.name}${description}`;
    const name = full.length > 100 ? full.slice(0, 99) + '…' : full;
    return { name, value: v.name };
  });

  await interaction.respond(choices);
}

// ─── Add: modal flow ─────────────────────────────────────────────────────────

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true).trim();

  const modal = new ModalBuilder()
    .setCustomId('venue-add-modal')
    .setTitle(`Add Venue: ${name.slice(0, 30)}`);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('venue-name')
        .setLabel('Venue Name')
        .setStyle(TextInputStyle.Short)
        .setValue(name)
        .setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('venue-description')
        .setLabel('Description (optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. DeFi lending protocol on Solana')
        .setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('venue-context')
        .setLabel('XP Context — why / how is XP calculated?')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. XP rewards liquidity providers based on TVL contribution')
        .setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('venue-link')
        .setLabel('Official URL (optional)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('https://kamino.finance')
        .setRequired(false),
    ),
  );

  await interaction.showModal(modal);
}

// ─── Edit: modal flow ────────────────────────────────────────────────────────

async function handleEditModal(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true).trim();
  const venue = await venueRepository.findByName(name);

  if (!venue) {
    await interaction.reply({
      content: `No active venue named **${name}** found. Use \`/venue list\` to see all venues.`,
      ephemeral: true,
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`venue-edit-modal:${encodeURIComponent(venue.name)}`)
    .setTitle(`Edit Venue: ${venue.name.slice(0, 30)}`);

  const setIfPresent = (builder: TextInputBuilder, value: string | null | undefined) => {
    if (value) builder.setValue(value);
    return builder;
  };

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      setIfPresent(
        new TextInputBuilder().setCustomId('venue-description').setLabel('Description (optional)').setStyle(TextInputStyle.Short).setRequired(false),
        venue.description,
      ),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      setIfPresent(
        new TextInputBuilder().setCustomId('venue-context').setLabel('XP Context — why / how is XP calculated?').setStyle(TextInputStyle.Short).setRequired(false),
        venue.context,
      ),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      setIfPresent(
        new TextInputBuilder().setCustomId('venue-link').setLabel('Official URL (optional)').setStyle(TextInputStyle.Short).setRequired(false),
        venue.link,
      ),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      setIfPresent(
        new TextInputBuilder().setCustomId('venue-disclaimer').setLabel('Disclaimer — risks & things to watch out for').setStyle(TextInputStyle.Paragraph).setRequired(false).setPlaceholder('e.g. LP positions are subject to impermanent loss. Rates may change without notice.'),
        venue.disclaimer,
      ),
    ),
  );

  await interaction.showModal(modal);
}

// ─── List ─────────────────────────────────────────────────────────────────────

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const venues = await venueRepository.findAll({ activeOnly: true });

  if (venues.length === 0) {
    await interaction.editReply({
      embeds: [
        infoEmbed('No Venues', 'No third-party venues have been added yet. Use `/venue add` to add one.'),
      ],
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Third-Party Venues')
    .setDescription(`**${venues.length}** active venue${venues.length === 1 ? '' : 's'}`)
    .setTimestamp();

  for (const venue of venues) {
    const xpRows = await venueAssetXPRepository.findByVenue(venue.id);
    const assetLines =
      xpRows.length > 0
        ? xpRows.map((r) => `• **${r.asset.symbol}** — ${r.xpRate}${r.notes ? ` _(${r.notes})_` : ''}`).join('\n')
        : '_No assets linked — use `/venue xp set`_';

    embed.addFields({
      name: venue.name + (venue.description ? ` — ${venue.description}` : ''),
      value: assetLines,
      inline: false,
    });
  }

  await interaction.editReply({ embeds: [embed] });
}

// ─── Remove ───────────────────────────────────────────────────────────────────

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const name = interaction.options.getString('name', true).trim();
  const removed = await venueRepository.softDelete(name);

  if (!removed) {
    await interaction.editReply({ content: `No active venue named **${name}** was found.` });
    return;
  }

  await interaction.editReply({ content: `Venue **${removed.name}** has been deactivated.` });
}

// ─── Details ──────────────────────────────────────────────────────────────────

async function handleDetails(interaction: ChatInputCommandInteraction): Promise<void> {
  const nameArg = interaction.options.getString('name');

  if (nameArg) {
    const venue = await venueRepository.findByName(nameArg.trim());
    if (!venue) {
      await interaction.editReply({ content: `No active venue named **${nameArg}** found. Use \`/venue list\` to see all venues.` });
      return;
    }
    const xpRows = await venueAssetXPRepository.findByVenue(venue.id);
    const assetLines =
      xpRows.length > 0
        ? xpRows.map((r) => `  - ${r.asset.symbol}: ${r.xpRate}${r.notes ? ` (${r.notes})` : ''}`).join('\n')
        : '  (none)';
    const block = [
      `=== ${venue.name} ===`,
      venue.description ? `description: ${venue.description}` : null,
      venue.context ? `context:     ${venue.context}` : null,
      venue.link ? `link:        ${venue.link}` : null,
      venue.disclaimer ? `disclaimer:  ${venue.disclaimer}` : null,
      `assets:\n${assetLines}`,
    ].filter(Boolean).join('\n');
    await interaction.editReply({ content: `\`\`\`\n${block}\n\`\`\`` });
    return;
  }

  const venues = await venueRepository.findAll({ activeOnly: true });

  if (venues.length === 0) {
    await interaction.editReply({ content: 'No active venues in the database.' });
    return;
  }

  const blocks = await Promise.all(
    venues.map(async (v) => {
      const xpRows = await venueAssetXPRepository.findByVenue(v.id);
      const assetLines =
        xpRows.length > 0
          ? xpRows.map((r) => `  - ${r.asset.symbol}: ${r.xpRate}${r.notes ? ` (${r.notes})` : ''}`).join('\n')
          : '  (none)';

      return [
        `=== ${v.name} ===`,
        v.description ? `description: ${v.description}` : null,
        v.context     ? `context:     ${v.context}` : null,
        v.link        ? `link:        ${v.link}` : null,
        v.disclaimer  ? `disclaimer:  ${v.disclaimer}` : null,
        `assets:\n${assetLines}`,
      ]
        .filter(Boolean)
        .join('\n');
    }),
  );

  // Discord message cap is 2000 chars — split across follow-ups when needed
  const LIMIT = 1900;
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    const segment = (current ? '\n\n' : '') + block;
    if (current.length + segment.length > LIMIT) {
      chunks.push(current);
      current = block;
    } else {
      current += segment;
    }
  }
  if (current) chunks.push(current);

  await interaction.editReply({ content: `\`\`\`\n${chunks[0]}\n\`\`\`` });
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ content: `\`\`\`\n${chunk}\n\`\`\``, ephemeral: true });
  }
}

// ─── XP: set / remove / list ─────────────────────────────────────────────────

async function handleXPSet(interaction: ChatInputCommandInteraction): Promise<void> {
  const venueName = interaction.options.getString('venue', true).trim();
  const symbol = interaction.options.getString('asset', true).trim().toUpperCase();
  const rate = interaction.options.getString('rate', true).trim();
  const notes = interaction.options.getString('notes')?.trim();

  const venue = await venueRepository.findByName(venueName);
  if (!venue) {
    await interaction.editReply({ content: `No active venue named **${venueName}** found. Use \`/venue list\` to see all venues.` });
    return;
  }
  const asset = await assetRepository.findBySymbol(symbol);
  if (!asset) {
    await interaction.editReply({ content: `No active asset **${symbol}** found. Add it first via \`/asset add\`.` });
    return;
  }

  const xp = await venueAssetXPRepository.upsert({
    venueId: venue.id,
    assetId: asset.id,
    xpRate: rate,
    notes: notes || undefined,
  });

  await interaction.editReply({
    content: `**${venue.name}** now offers **${asset.symbol}**: ${xp.xpRate}${xp.notes ? ` _(${xp.notes})_` : ''}`,
  });
}

async function handleXPRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const venueName = interaction.options.getString('venue', true).trim();
  const symbol = interaction.options.getString('asset', true).trim().toUpperCase();

  const venue = await venueRepository.findByName(venueName);
  if (!venue) {
    await interaction.editReply({ content: `No active venue named **${venueName}** found.` });
    return;
  }
  const asset = await assetRepository.findBySymbol(symbol);
  if (!asset) {
    await interaction.editReply({ content: `No active asset **${symbol}** found.` });
    return;
  }

  const removed = await venueAssetXPRepository.remove(venue.id, asset.id);
  await interaction.editReply({
    content: removed
      ? `Removed **${asset.symbol}** XP from **${venue.name}**.`
      : `**${venue.name}** had no XP entry for **${asset.symbol}**.`,
  });
}

async function handleXPList(interaction: ChatInputCommandInteraction): Promise<void> {
  const venueName = interaction.options.getString('venue', true).trim();

  const venue = await venueRepository.findByName(venueName);
  if (!venue) {
    await interaction.editReply({ content: `No active venue named **${venueName}** found.` });
    return;
  }

  const rows = await venueAssetXPRepository.findByVenue(venue.id);
  if (rows.length === 0) {
    await interaction.editReply({ content: `**${venue.name}** has no asset XP rates configured yet. Use \`/venue xp set\`.` });
    return;
  }

  const lines = rows.map((r) => `• **${r.asset.symbol}** — ${r.xpRate}${r.notes ? ` _(${r.notes})_` : ''}`).join('\n');
  await interaction.editReply({ content: `**${venue.name}** XP rates:\n${lines}` });
}

// ─── Utility ──────────────────────────────────────────────────────────────────

export async function formatVenueForEmbed(venue: Venue): Promise<string> {
  const xpRows = await venueAssetXPRepository.findByVenue(venue.id);
  if (xpRows.length === 0) return '_No assets linked yet_';
  return xpRows
    .map((r) => `**${r.asset.symbol}**: ${r.xpRate}${r.notes ? ` (${r.notes})` : ''}`)
    .join(' | ');
}
