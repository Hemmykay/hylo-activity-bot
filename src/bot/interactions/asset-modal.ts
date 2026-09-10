import type { AssetCategory } from '@prisma/client';
import type { ModalSubmitInteraction } from 'discord.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { assertAuthorizedInteraction, replyWithError } from '@/lib/discord-utils.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('asset-modal');

// ─── Category parsing ─────────────────────────────────────────────────────────

function parseCategory(raw: string): AssetCategory | null {
  if (!raw.trim()) return null;
  const s = raw.trim().toUpperCase().replace(/[\s-]+/g, '_');
  switch (s) {
    case 'LST': return 'LST';
    case 'STABLECOIN': return 'STABLECOIN';
    case 'LEVER_TOKEN':
    case 'LEVER': return 'LEVER_TOKEN';
    case 'YIELD_BEARING_TOKEN':
    case 'YIELD_BEARING':
    case 'YIELD': return 'YIELD_BEARING_TOKEN';
    default: return null;
  }
}

const VALID_CATEGORIES = 'LST · STABLECOIN · LEVER_TOKEN · YIELD_BEARING_TOKEN';

// ─── Handlers ─────────────────────────────────────────────────────────────────

export async function handleAssetAddModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    await assertAuthorizedInteraction(interaction);
    // Symbol is encoded in customId as "asset-add-modal:SYMBOL"
    const colonIdx = interaction.customId.indexOf(':');
    const symbol = colonIdx >= 0 ? interaction.customId.slice(colonIdx + 1).toUpperCase() : '';
    if (!symbol) { await interaction.reply({ content: 'Could not determine asset symbol.', ephemeral: true }); return; }

    const name = interaction.fields.getTextInputValue('asset-name').trim();
    if (!name) { await interaction.reply({ content: 'Name is required.', ephemeral: true }); return; }

    const description    = interaction.fields.getTextInputValue('asset-description').trim();
    const considerations = interaction.fields.getTextInputValue('asset-considerations').trim();
    const tokenAddress   = interaction.fields.getTextInputValue('asset-token-address').trim();
    const categoryRaw    = interaction.fields.getTextInputValue('asset-category').trim();

    let category: AssetCategory | undefined;
    if (categoryRaw) {
      const parsed = parseCategory(categoryRaw);
      if (!parsed) {
        await interaction.reply({ content: `Invalid category **${categoryRaw}**. Valid values: ${VALID_CATEGORIES}`, ephemeral: true });
        return;
      }
      category = parsed;
    }

    const asset = await assetRepository.upsert({
      symbol, name, addedBy: interaction.user.id,
      ...(description    && { description }),
      ...(considerations && { considerations }),
      ...(tokenAddress   && { tokenAddress }),
      ...(category       && { category }),
    });

    await interaction.reply({ content: formatAssetSummary('Asset saved.', asset), ephemeral: true });
    logger.info({ symbol: asset.symbol, category: asset.category }, 'Asset saved via modal');
  } catch (err) {
    await replyWithError(interaction, err);
  }
}

export async function handleAssetEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    await assertAuthorizedInteraction(interaction);
    const [, symbol] = interaction.customId.split(':') as [string, string];
    if (!symbol) return;

    const existing = await assetRepository.findBySymbol(symbol);
    if (!existing) {
      await interaction.reply({ content: `Asset **${symbol}** no longer exists.`, ephemeral: true });
      return;
    }

    const name           = interaction.fields.getTextInputValue('asset-name').trim();
    const description    = interaction.fields.getTextInputValue('asset-description').trim();
    const considerations = interaction.fields.getTextInputValue('asset-considerations').trim();
    const tokenAddress   = interaction.fields.getTextInputValue('asset-token-address').trim();
    const categoryRaw    = interaction.fields.getTextInputValue('asset-category').trim();

    let category: AssetCategory | undefined;
    if (categoryRaw) {
      const parsed = parseCategory(categoryRaw);
      if (!parsed) {
        await interaction.reply({ content: `Invalid category **${categoryRaw}**. Valid values: ${VALID_CATEGORIES}`, ephemeral: true });
        return;
      }
      category = parsed;
    }

    const asset = await assetRepository.upsert({
      symbol, name, addedBy: interaction.user.id,
      ...(description    && { description }),
      ...(considerations && { considerations }),
      ...(tokenAddress   && { tokenAddress }),
      ...(category       && { category }),
    });

    await interaction.reply({ content: formatAssetSummary('Asset updated.', asset), ephemeral: true });
    logger.info({ symbol: asset.symbol, category: asset.category }, 'Asset updated via modal');
  } catch (err) {
    await replyWithError(interaction, err);
  }
}

export async function handleAssetConfigureModal(interaction: ModalSubmitInteraction): Promise<void> {
  try {
    await assertAuthorizedInteraction(interaction);
    const [, symbol] = interaction.customId.split(':') as [string, string];
    if (!symbol) return;

    const stakeVaultRaw       = interaction.fields.getTextInputValue('asset-stake-vault').trim();
    const collateralWalletRaw = interaction.fields.getTextInputValue('asset-collateral-wallet').trim();

    // Normalise vault list: trim each address, remove empties, rejoin
    const stakeVault       = stakeVaultRaw ? stakeVaultRaw.split(',').map((s) => s.trim()).filter(Boolean).join(', ') : null;
    const collateralWallet = collateralWalletRaw || null;

    const asset = await assetRepository.updateMeta(symbol, { stakeVault, collateralWallet });
    if (!asset) {
      await interaction.reply({ content: `Asset **${symbol}** not found.`, ephemeral: true });
      return;
    }

    const lines = [`**${asset.symbol}** configured:`];
    if (asset.stakeVault) lines.push(`\nStake Vault(s): \`${asset.stakeVault}\``);
    else lines.push('\nStake Vault(s): _(cleared)_');
    if (asset.collateralWallet) lines.push(`\nCollateral Wallet: \`${asset.collateralWallet}\``);
    else lines.push('\nCollateral Wallet: _(cleared)_');

    await interaction.reply({ content: lines.join(''), ephemeral: true });
    logger.info({ symbol: asset.symbol, stakeVault, collateralWallet }, 'Asset meta configured');
  } catch (err) {
    await replyWithError(interaction, err);
  }
}

// ─── Formatting helper ────────────────────────────────────────────────────────

function formatAssetSummary(prefix: string, asset: Awaited<ReturnType<typeof assetRepository.upsert>>): string {
  const CATEGORY_LABELS: Record<string, string> = {
    LST: 'LST',
    STABLECOIN: 'Stablecoin',
    LEVER_TOKEN: 'Lever Token',
    YIELD_BEARING_TOKEN: 'Yield-Bearing Token',
  };
  const lines = [`**${asset.symbol}** — ${asset.name}`];
  if (asset.category) lines.push(`\nCategory: ${CATEGORY_LABELS[asset.category] ?? asset.category}`);
  if (asset.description) lines.push(`\n${asset.description}`);
  if (asset.considerations) lines.push(`\n⚠ ${asset.considerations}`);
  if (asset.tokenAddress) lines.push(`\nMint: \`${asset.tokenAddress}\``);
  return `${prefix}\n\n${lines.join('')}`;
}
