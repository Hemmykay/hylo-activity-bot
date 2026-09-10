import type { Asset, AssetCategory } from '@prisma/client';
import { prisma } from '../prisma.js';

export type CreateAssetInput = {
  symbol: string;
  name: string;
  description?: string;
  considerations?: string;
  tokenAddress?: string;
  category?: AssetCategory;
  addedBy: string;
};

export type AssetMetaInput = {
  stakeVault?: string | null;
  collateralWallet?: string | null;
};

export const assetRepository = {
  async findAll(options?: { activeOnly?: boolean }): Promise<Asset[]> {
    return prisma.asset.findMany({
      where: options?.activeOnly !== false ? { isActive: true } : {},
      orderBy: { symbol: 'asc' },
    });
  },

  async findBySymbol(symbol: string): Promise<Asset | null> {
    return prisma.asset.findUnique({ where: { symbol: symbol.toUpperCase() } });
  },

  async upsert(data: CreateAssetInput): Promise<Asset> {
    const symbol = data.symbol.toUpperCase();
    const shared = {
      name: data.name,
      ...(data.description !== undefined && { description: data.description }),
      ...(data.considerations !== undefined && { considerations: data.considerations }),
      ...(data.tokenAddress !== undefined && { tokenAddress: data.tokenAddress }),
      ...(data.category !== undefined && { category: data.category }),
      addedBy: data.addedBy,
    };
    return prisma.asset.upsert({
      where: { symbol },
      create: { symbol, ...shared },
      update: { ...shared, isActive: true },
    });
  },

  async updateMeta(symbol: string, data: AssetMetaInput): Promise<Asset | null> {
    const sym = symbol.toUpperCase();
    const asset = await prisma.asset.findUnique({ where: { symbol: sym } });
    if (!asset) return null;
    return prisma.asset.update({
      where: { symbol: sym },
      data: {
        ...(data.stakeVault !== undefined && { stakeVault: data.stakeVault }),
        ...(data.collateralWallet !== undefined && { collateralWallet: data.collateralWallet }),
      },
    });
  },

  /** Persists the last cap-progress milestone announced to Discord, so a restart doesn't lose track of it. */
  async updateLastAnnouncedCapMilestone(symbol: string, milestoneUsd: number): Promise<void> {
    await prisma.asset.update({
      where: { symbol: symbol.toUpperCase() },
      data: { lastAnnouncedCapMilestoneUsd: milestoneUsd },
    });
  },

  async softDelete(symbol: string): Promise<Asset | null> {
    const asset = await prisma.asset.findUnique({ where: { symbol: symbol.toUpperCase() } });
    if (!asset) return null;
    return prisma.asset.update({ where: { symbol: symbol.toUpperCase() }, data: { isActive: false } });
  },

  async searchForAutocomplete(query: string): Promise<Asset[]> {
    if (!query.trim()) {
      return prisma.asset.findMany({
        where: { isActive: true },
        orderBy: { symbol: 'asc' },
        take: 25,
      });
    }
    return prisma.asset.findMany({
      where: {
        isActive: true,
        OR: [
          { symbol: { contains: query.toUpperCase(), mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { symbol: 'asc' },
      take: 25,
    });
  },
};
