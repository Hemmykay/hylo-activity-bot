import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { resolveEHYUSDPriceAndSupply } from '@/services/price/asset-price.service.js';
import { formatCapMessage } from '@/services/mint-watcher/ehyusd-cap-watcher.service.js';
import { assertAuthorizedInteraction, replyWithError } from '@/lib/discord-utils.js';

export const data = new SlashCommandBuilder()
  .setName('ehyusd-cap')
  .setDescription('Check how close eHYUSD is to its supply cap');

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await assertAuthorizedInteraction(interaction);
  await interaction.deferReply();

  try {
    const eHYUSDAsset = await assetRepository.findBySymbol('EHYUSD');
    if (!eHYUSDAsset?.capUsd) {
      await interaction.editReply('eHYUSD does not have a cap configured yet.');
      return;
    }

    const assets = await assetRepository.findAll({ activeOnly: true });
    const assetMap = new Map(assets.map((a) => [a.symbol, a]));
    const resolved = await resolveEHYUSDPriceAndSupply(assetMap);
    if (!resolved) {
      await interaction.editReply("Couldn't resolve eHYUSD's current value right now — try again shortly.");
      return;
    }

    const currentUsd = resolved.price * resolved.supply;
    await interaction.editReply(formatCapMessage('eHYUSD', eHYUSDAsset.emoji, currentUsd, eHYUSDAsset.capUsd));
  } catch (err) {
    await replyWithError(interaction, err);
  }
}
