/**
 * Isolated X (Twitter) posting service.
 *
 * postTweet never throws — matches the same contract as helius.service.ts:
 * a failure here (missing config, rate limit, network error) must never
 * affect Discord posting, which is the only channel that's actually required.
 */
import { TwitterApi } from 'twitter-api-v2';
import { config } from '@/config/index.js';
import { createLogger } from '@/lib/logger.js';

const logger = createLogger('twitter');

// Standard (non-premium) posting limit. We don't attempt to truncate a
// too-long tweet into something misleading — better to skip it and log.
const TWEET_MAX_LENGTH = 280;

const client = config.twitter.enabled
  ? new TwitterApi({
      appKey: config.twitter.apiKey,
      appSecret: config.twitter.apiSecret,
      accessToken: config.twitter.accessToken,
      accessSecret: config.twitter.accessTokenSecret,
    })
  : null;

export type TweetResult = { success: true } | { success: false; error: string };

export const twitterService = {
  get enabled(): boolean {
    return client !== null;
  },

  async postTweet(text: string): Promise<TweetResult> {
    if (!client) return { success: false, error: 'Twitter is not configured' };

    if (text.length > TWEET_MAX_LENGTH) {
      logger.warn({ length: text.length, max: TWEET_MAX_LENGTH }, 'Tweet exceeds max length — not posting');
      return { success: false, error: `Text exceeds ${TWEET_MAX_LENGTH} characters (${text.length})` };
    }

    try {
      await client.v2.tweet(text);
      logger.info({ length: text.length }, 'Tweet posted');
      return { success: true };
    } catch (err) {
      logger.error({ err }, 'Failed to post tweet');
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
