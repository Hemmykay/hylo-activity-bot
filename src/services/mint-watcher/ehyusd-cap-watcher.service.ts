/**
 * Posts eHYUSD's progress toward its supply cap to a Discord channel every
 * time it crosses a new $100K milestone (e.g. $10.2M, $10.3M, ...).
 *
 * The last-announced milestone is persisted on the Asset row itself
 * (Asset.lastAnnouncedCapMilestoneUsd) — a deliberate exception to the rest
 * of the mint watcher's in-memory-only, never-backfill checkpoints. Those
 * exist to avoid replaying a *stream of discrete blockchain events* after
 * downtime; this is a single monotonic progress value with nothing to
 * replay, so there's no backfill risk in remembering it. Without persisting
 * it, every process restart would re-run the cold-start guess below, and in
 * practice (frequent dev restarts, occasional prod redeploys) that meant it
 * almost never actually fired — confirmed happening for real: the tracked
 * value spent a long stretch sitting ~$100K past the nearest lower mark,
 * just outside the cold-start tolerance, so *every* restart re-baselined
 * silently instead of posting.
 */
import type { Client } from 'discord.js';
import type { Asset } from '@prisma/client';
import { config } from '@/config/index.js';
import { assetRepository } from '@/db/repositories/asset.repository.js';
import { resolveEHYUSDPriceAndSupply } from '@/services/price/asset-price.service.js';
import { getSendableChannel, renderProgressBar, fmtUsdM } from '@/lib/discord-utils.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('ehyusd-cap-watcher');

const MILESTONE_STEP_USD = 100_000;

// Only relevant the very first time this feature ever runs for this asset
// (Asset.lastAnnouncedCapMilestoneUsd is still null) — after that, the
// persisted value makes every subsequent check exact, no guessing needed.
// On that true first run, only announce the nearest milestone below the
// current value if we're still close to it — explainable as one ordinary
// mint having just pushed it over — so if this feature launches when the
// value is already well past a mark, it doesn't retroactively announce
// something that's effectively old news.
const COLD_START_CLOSE_TOLERANCE_USD = 50_000;

function floorToMilestone(usd: number): number {
  return Math.floor(usd / MILESTONE_STEP_USD) * MILESTONE_STEP_USD;
}

/** Shared with the /ehyusd-cap command so the on-demand check and the milestone poster render identically. */
export function formatCapMessage(label: string, emoji: string | null, currentUsd: number, capUsd: number): string {
  const emojiPart = emoji ? `${emoji} ` : '';
  const fraction = currentUsd / capUsd;
  const bar = renderProgressBar(fraction);
  const pct = Math.round(Math.min(1, fraction) * 100);
  return `**${emojiPart}${label}: ** (${fmtUsdM(currentUsd)} / ${fmtUsdM(capUsd)})\n${bar} ${pct}%`;
}

async function postMilestone(client: Client, currentUsd: number, capUsd: number, emoji: string | null): Promise<void> {
  const channelId = config.ehyusdCap.channelId;
  if (!channelId) return;
  const channel = await getSendableChannel(client, channelId);
  if (!channel) return;
  await channel.send(formatCapMessage('eHYUSD Cap Progress', emoji, currentUsd, capUsd));
}

export async function checkEHYUSDCapMilestone(client: Client, assetMap: Map<string, Asset>): Promise<void> {
  if (!config.ehyusdCap.channelId) return;

  const eHYUSDAsset = assetMap.get('EHYUSD');
  if (!eHYUSDAsset?.capUsd) return;

  const resolved = await resolveEHYUSDPriceAndSupply(assetMap);
  if (!resolved) return;

  const currentUsd = resolved.price * resolved.supply;
  const currentMilestone = floorToMilestone(currentUsd);
  const lastAnnouncedMilestoneUsd = eHYUSDAsset.lastAnnouncedCapMilestoneUsd;

  if (lastAnnouncedMilestoneUsd === null) {
    const overshoot = currentUsd - currentMilestone;
    if (currentMilestone > 0 && overshoot <= COLD_START_CLOSE_TOLERANCE_USD) {
      await postMilestone(client, currentUsd, eHYUSDAsset.capUsd, eHYUSDAsset.emoji);
      logger.info({ milestone: currentMilestone, currentUsd, overshoot }, 'eHYUSD cap milestone announced (first run, close enough)');
    } else {
      logger.info({ milestone: currentMilestone, currentUsd, overshoot }, 'eHYUSD cap milestone baseline set silently (first run, not close)');
    }
    await assetRepository.updateLastAnnouncedCapMilestone('EHYUSD', currentMilestone);
    return;
  }

  if (currentMilestone > lastAnnouncedMilestoneUsd) {
    await postMilestone(client, currentUsd, eHYUSDAsset.capUsd, eHYUSDAsset.emoji);
    logger.info({ milestone: currentMilestone, previousMilestone: lastAnnouncedMilestoneUsd, currentUsd }, 'eHYUSD cap milestone announced');
    await assetRepository.updateLastAnnouncedCapMilestone('EHYUSD', currentMilestone);
  }
}
