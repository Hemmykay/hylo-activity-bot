import type { Venue } from '@prisma/client';
import { prisma } from '../prisma.js';

export type CreateVenueInput = {
  name: string;
  description?: string;
  context?: string;
  link?: string;
  disclaimer?: string;
  addedBy: string;
};

export const venueRepository = {
  async findAll(options?: { activeOnly?: boolean }): Promise<Venue[]> {
    return prisma.venue.findMany({
      where: options?.activeOnly !== false ? { isActive: true } : {},
      orderBy: { name: 'asc' },
    });
  },

  async findByName(name: string): Promise<Venue | null> {
    return prisma.venue.findUnique({ where: { name } });
  },

  async create(data: CreateVenueInput): Promise<Venue> {
    return prisma.venue.create({
      data: {
        name: data.name,
        ...(data.description !== undefined && { description: data.description }),
        ...(data.context !== undefined && { context: data.context }),
        ...(data.link !== undefined && { link: data.link }),
        ...(data.disclaimer !== undefined && { disclaimer: data.disclaimer }),
        addedBy: data.addedBy,
      },
    });
  },

  async upsert(data: CreateVenueInput): Promise<Venue> {
    const shared = {
      ...(data.description !== undefined && { description: data.description }),
      ...(data.context !== undefined && { context: data.context }),
      ...(data.link !== undefined && { link: data.link }),
      ...(data.disclaimer !== undefined && { disclaimer: data.disclaimer }),
      addedBy: data.addedBy,
    };
    return prisma.venue.upsert({
      where: { name: data.name },
      create: { name: data.name, ...shared },
      update: { ...shared, isActive: true },
    });
  },

  async searchForAutocomplete(query: string): Promise<Venue[]> {
    if (!query.trim()) {
      return prisma.venue.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        take: 25,
      });
    }
    return prisma.venue.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: { name: 'asc' },
      take: 25,
    });
  },

  async softDelete(name: string): Promise<Venue | null> {
    const venue = await prisma.venue.findUnique({ where: { name } });
    if (!venue) return null;
    return prisma.venue.update({ where: { name }, data: { isActive: false } });
  },
};
