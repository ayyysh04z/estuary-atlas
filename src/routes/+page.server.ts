import type { PageServerLoad } from './$types';
import { PIPELINES } from '$lib/pipelines';
import { flowctl, type CatalogListItem, type HistoryEvent } from '$lib/server/flowctl';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

interface PipelineCard {
  slug: string;
  sources: number;
  collections: number;
  destinations: number;
  recentHumanPub: boolean;
  error?: string;
}

async function countTyped(prefix: string, type: 'captures' | 'collections' | 'materializations'): Promise<number> {
  try {
    const items = await flowctl<CatalogListItem[]>([
      'catalog',
      'list',
      '--prefix',
      prefix,
      `--${type}`,
      '-o',
      'json'
    ]);
    return items.length;
  } catch {
    return 0;
  }
}

async function loadCard(p: (typeof PIPELINES)[number]): Promise<PipelineCard> {
  try {
    const [sources, collections, destinations] = await Promise.all([
      countTyped(p.prefixes.source, 'captures'),
      countTyped(p.prefixes.collection, 'collections'),
      countTyped(p.prefixes.destination, 'materializations')
    ]);
    // Skip history for the card view - too expensive to load for all pipelines up front.
    return {
      slug: p.slug,
      sources,
      collections,
      destinations,
      recentHumanPub: false
    };
  } catch (e) {
    return {
      slug: p.slug,
      sources: 0,
      collections: 0,
      destinations: 0,
      recentHumanPub: false,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

export const load: PageServerLoad = async () => {
  const cards = await Promise.all(PIPELINES.map(loadCard));
  return { cards };
};
