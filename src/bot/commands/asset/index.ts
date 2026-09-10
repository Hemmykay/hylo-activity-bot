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
import type { AssetCategory } from '@prisma/client';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { venueAssetXPRepository } from '@/db/repositories/venue-asset-xp.repository.js';
import { assertAuthorizedInteraction, replyWithError, COLORS, infoEmbed } from '@/lib/discord-utils.js';

export const data = new SlashCommandBuilder()
  .setName('asset')
  .setDescription("Manage Hylo's native assets (xSOL, hyUSD, etc.)")
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Add a Hylo asset')
      .addStringOption((opt) =>
        opt.setName('symbol').setDescription('Token symbol (e.g. HYLOSOL)').setRequired(true),
      ),
  )
  .addSubcommand((sub) => sub.setName('list').setDescription('List all active Hylo assets'))
  .addSubcommand((sub) =>
    sub
      .setName('details')
      .setDescription('Show full details for an asset, or all assets if no symbol is given')
      .addStringOption((opt) =>
        opt
          .setName('symbol')
          .setDescription('Token symbol — leave blank to show all assets')
          .setRequired(false)
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('edit')
      .setDescription('Edit an asset')
      .addStringOption((opt) =>
        opt.setName('symbol').setDescription('Start typing to search assets').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('configure')
      .setDescription('Set stake vault or collateral wallet for an asset')
      .addStringOption((opt) =>
        opt.setName('symbol').setDescription('Start typing to search assets').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Remove an asset')
      .addStringOption((opt) =>
        opt.setName('symbol').setDescription('Start typing to search assets').setRequired(true).setAutocomplete(true),
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  const sub = interaction.options.getSubcommand(true);

  if (sub === 'add' || sub === 'edit' || sub === 'configure') {
    try {
      if (sub === 'add') await handleAdd(interaction);
      else if (sub === 'edit') await handleEditModal(interaction);
      else await handleConfigure(interaction);
    } catch (err) {
      await replyWithError(interaction, err);
    }
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    if (sub === 'list') await handleList(interaction);
    else if (sub === 'details') await handleDetails(interaction);
    else if (sub === 'remove') await handleRemove(interaction);
  } catch (err) {
    await replyWithError(interaction, err);
  }
}

export async function autocomplete(interaction: AutocompleteInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  if (sub !== 'edit' && sub !== 'remove' && sub !== 'details' && sub !== 'configure') {
    await interaction.respond([]);
    return;
  }
  const query = interaction.options.getFocused();
  const assets = await assetRepository.searchForAutocomplete(query);
  const choices = assets.map((a) => ({
    name: `${a.symbol} — ${a.name}`,
    value: a.symbol,
  }));
  await interaction.respond(choices);
}

// ─── Category helpers ─────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<string, string> = {
  LST: 'LST',
  STABLECOIN: 'Stablecoin',
  LEVER_TOKEN: 'Lever Token',
  YIELD_BEARING_TOKEN: 'Yield-Bearing Token',
};

function categoryLabel(cat: AssetCategory | null): string | null {
  if (!cat) return null;
  return CATEGORY_LABELS[cat] ?? cat;
}

// ─── Modal builders ───────────────────────────────────────────────────────────

async function handleAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const symbol = interaction.options.getString('symbol', true).toUpperCase().trim();
  // Encode symbol in customId so the handler doesn't need a separate modal row for it
  const modal = new ModalBuilder().setCustomId(`asset-add-modal:${symbol}`).setTitle(`Add Asset: ${symbol}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('asset-name').setLabel('Full name').setStyle(TextInputStyle.Short).setPlaceholder('e.g. Hylo Staked SOL').setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('asset-description').setLabel('Description — what it is and how it works').setStyle(TextInputStyle.Paragraph).setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('asset-considerations').setLabel('Considerations — risks & key mechanics').setStyle(TextInputStyle.Paragraph).setPlaceholder('e.g. xSOL can de-peg during high volatility.').setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('asset-token-address').setLabel('Token Address (Solana mint)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. So11111111111111111111111111111111111111112').setRequired(false),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('asset-category').setLabel('Category').setStyle(TextInputStyle.Short).setPlaceholder('LST · STABLECOIN · LEVER_TOKEN · YIELD_BEARING_TOKEN').setRequired(false),
    ),
  );
  await interaction.showModal(modal);
}

async function handleEditModal(interaction: ChatInputCommandInteraction): Promise<void> {
  const symbol = interaction.options.getString('symbol', true).toUpperCase().trim();
  const asset = await assetRepository.findBySymbol(symbol);
  if (!asset) {
    await interaction.reply({ content: `No active asset **${symbol}** found. Use \`/asset list\` to see all assets.`, ephemeral: true });
    return;
  }
  const modal = new ModalBuilder().setCustomId(`asset-edit-modal:${asset.symbol}`).setTitle(`Edit Asset: ${asset.symbol}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId('asset-name').setLabel('Full name').setStyle(TextInputStyle.Short).setValue(asset.name).setRequired(true),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      (() => {
        const f = new TextInputBuilder().setCustomId('asset-description').setLabel('Description — what it is and how it works').setStyle(TextInputStyle.Paragraph).setRequired(false);
        if (asset.description) f.setValue(asset.description);
        return f;
      })(),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      (() => {
        const f = new TextInputBuilder().setCustomId('asset-considerations').setLabel('Considerations — risks & key mechanics').setStyle(TextInputStyle.Paragraph).setRequired(false);
        if (asset.considerations) f.setValue(asset.considerations);
        return f;
      })(),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      (() => {
        const f = new TextInputBuilder().setCustomId('asset-token-address').setLabel('Token Address (Solana mint)').setStyle(TextInputStyle.Short).setPlaceholder('e.g. So11111111111111111111111111111111111111112').setRequired(false);
        if (asset.tokenAddress) f.setValue(asset.tokenAddress);
        return f;
      })(),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      (() => {
        const f = new TextInputBuilder().setCustomId('asset-category').setLabel('Category').setStyle(TextInputStyle.Short).setPlaceholder('LST · STABLECOIN · LEVER_TOKEN · YIELD_BEARING_TOKEN').setRequired(false);
        if (asset.category) f.setValue(asset.category);
        return f;
      })(),
    ),
  );
  await interaction.showModal(modal);
}

async function handleConfigure(interaction: ChatInputCommandInteraction): Promise<void> {
  const symbol = interaction.options.getString('symbol', true).toUpperCase().trim();
  const asset = await assetRepository.findBySymbol(symbol);
  if (!asset) {
    await interaction.reply({ content: `No active asset **${symbol}** found. Use \`/asset list\` to see all assets.`, ephemeral: true });
    return;
  }
  const modal = new ModalBuilder().setCustomId(`asset-configure-modal:${asset.symbol}`).setTitle(`Configure: ${asset.symbol}`);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      (() => {
        const f = new TextInputBuilder()
          .setCustomId('asset-stake-vault')
          .setLabel('Stake Vault Accounts (LST only)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Comma-separated stake account addresses')
          .setRequired(false);
        if (asset.stakeVault) f.setValue(asset.stakeVault);
        return f;
      })(),
    ),
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      (() => {
        const f = new TextInputBuilder()
          .setCustomId('asset-collateral-wallet')
          .setLabel('Collateral Wallet (Yield-bearing only)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Solana wallet address')
          .setRequired(false);
        if (asset.collateralWallet) f.setValue(asset.collateralWallet);
        return f;
      })(),
    ),
  );
  await interaction.showModal(modal);
}

// ─── Read-only handlers ───────────────────────────────────────────────────────

async function handleList(interaction: ChatInputCommandInteraction): Promise<void> {
  const assets = await assetRepository.findAll({ activeOnly: true });
  if (assets.length === 0) {
    await interaction.editReply({ embeds: [infoEmbed('No Assets', 'No assets have been added yet. Use `/asset add` to add one.')] });
    return;
  }
  const embed = new EmbedBuilder().setColor(COLORS.info).setTitle('Hylo Assets').setDescription(`**${assets.length}** active asset${assets.length === 1 ? '' : 's'}`).setTimestamp();
  for (const a of assets) {
    const cat = categoryLabel(a.category);
    const value = [
      cat ? `\`${cat}\`  ` : '',
      a.description ?? '_No description_',
      a.considerations ? `\n⚠ ${a.considerations}` : '',
    ].join('');
    embed.addFields({ name: `${a.symbol} — ${a.name}`, value: value.slice(0, 1024), inline: false });
  }
  await interaction.editReply({ embeds: [embed] });
}

async function handleDetails(interaction: ChatInputCommandInteraction): Promise<void> {
  const symbolArg = interaction.options.getString('symbol');

  if (symbolArg) {
    const asset = await assetRepository.findBySymbol(symbolArg.toUpperCase().trim());
    if (!asset) {
      await interaction.editReply({ content: `No active asset **${symbolArg.toUpperCase()}** found. Use \`/asset list\` to see all assets.` });
      return;
    }
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle(`${asset.symbol} — ${asset.name}`)
      .setTimestamp();
    if (asset.description) embed.setDescription(asset.description);
    const cat = categoryLabel(asset.category);
    if (cat) embed.addFields({ name: 'Category', value: cat, inline: true });
    if (asset.tokenAddress) embed.addFields({ name: 'Mint Address', value: `\`${asset.tokenAddress}\``, inline: false });
    if (asset.stakeVault) embed.addFields({ name: 'Stake Vault(s)', value: `\`${asset.stakeVault}\``, inline: false });
    if (asset.collateralWallet) embed.addFields({ name: 'Collateral Wallet', value: `\`${asset.collateralWallet}\``, inline: false });
    if (asset.considerations) embed.addFields({ name: 'Considerations', value: asset.considerations, inline: false });

    const xpRows = await venueAssetXPRepository.findByAsset(asset.id);
    if (xpRows.length > 0) {
      const lines = xpRows.map((r) => `• **${r.venue.name}** — ${r.xpRate}${r.notes ? ` _(${r.notes})_` : ''}`).join('\n');
      embed.addFields({ name: `XP by Venue (${xpRows.length})`, value: lines.slice(0, 1024), inline: false });
    } else {
      embed.addFields({ name: 'XP by Venue', value: '_Not linked to any venue yet — use `/venue xp set`_', inline: false });
    }

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const assets = await assetRepository.findAll({ activeOnly: true });
  if (assets.length === 0) {
    await interaction.editReply({ embeds: [infoEmbed('No Assets', 'No assets have been added yet.')] });
    return;
  }
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('Hylo Assets — Full Details')
    .setDescription(`**${assets.length}** active asset${assets.length === 1 ? '' : 's'}`)
    .setTimestamp();
  for (const a of assets) {
    const cat = categoryLabel(a.category);
    const parts = [
      cat ? `**Category:** ${cat}\n` : '',
      a.description ?? '_No description_',
      a.tokenAddress ? `\nMint: \`${a.tokenAddress}\`` : '',
      a.stakeVault ? `\nVault: \`${a.stakeVault}\`` : '',
      a.collateralWallet ? `\nCollateral: \`${a.collateralWallet}\`` : '',
      a.considerations ? `\n⚠ ${a.considerations}` : '',
    ];
    embed.addFields({ name: `${a.symbol} — ${a.name}`, value: parts.join('').slice(0, 1024), inline: false });
  }
  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const symbol = interaction.options.getString('symbol', true).toUpperCase().trim();
  const removed = await assetRepository.softDelete(symbol);
  if (!removed) { await interaction.editReply({ content: `No active asset **${symbol}** was found.` }); return; }
  await interaction.editReply({ content: `Asset **${removed.symbol}** has been deactivated.` });
}
