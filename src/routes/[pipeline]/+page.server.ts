import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getPipeline } from '$lib/pipelines';
import { flowctl, type CatalogListItem, type HistoryEvent } from '$lib/server/flowctl';

async function listTyped(
  prefix: string,
  type: 'captures' | 'collections' | 'materializations'
): Promise<CatalogListItem[]> {
  try {
    return await flowctl<CatalogListItem[]>([
      'catalog',
      'list',
      '--prefix',
      prefix,
      `--${type}`,
      '-o',
      'json'
    ]);
  } catch {
    return [];
  }
}

async function historyFor(name: string): Promise<HistoryEvent[]> {
  try {
    return await flowctl<HistoryEvent[]>([
      'catalog',
      'history',
      '--name',
      name,
      '--models',
      '-o',
      'json'
    ]);
  } catch {
    return [];
  }
}

export const load: PageServerLoad = async ({ params }) => {
  const pipeline = getPipeline(params.pipeline);
  if (!pipeline) throw error(404, 'unknown pipeline');

  // Fetch catalog lists in parallel — these are cheap and awaited so the page
  // has the sidebar / lane counts / task dropdown immediately.
  const [captures, collections, materializations] = await Promise.all([
    listTyped(pipeline.prefixes.source, 'captures'),
    listTyped(pipeline.prefixes.collection, 'collections'),
    listTyped(pipeline.prefixes.destination, 'materializations')
  ]);

  // History+models is expensive (one flowctl per spec). Return it as an
  // UNRESOLVED promise — SvelteKit streams it to the client so the page renders
  // immediately and History/chip enrichment fills in with skeletons.
  const streamed = (async () => {
    const allSpecs = [...captures, ...collections, ...materializations];
    const historyByName = new Map<string, HistoryEvent[]>();
    await Promise.all(
      allSpecs.map(async (item) => {
        const events = await historyFor(item.catalogName);
        events.sort((a, b) => {
          const pa = (a.publication ?? {}) as Record<string, unknown>;
          const pb = (b.publication ?? {}) as Record<string, unknown>;
          return String(pb.publishedAt ?? '').localeCompare(String(pa.publishedAt ?? ''));
        });
        historyByName.set(item.catalogName, events);
      })
    );

    const pubIds = new Set<string>();
    const uniquePubs: HistoryEvent[] = [];
    for (const events of historyByName.values()) {
      for (const e of events) {
        const pub = (e.publication ?? {}) as Record<string, unknown>;
        const id = String(pub.publicationId ?? e.publicationId ?? e.pubId ?? '');
        if (!id || pubIds.has(id)) continue;
        pubIds.add(id);
        uniquePubs.push(e);
      }
    }
    uniquePubs.sort((a, b) => {
      const pa = (a.publication ?? {}) as Record<string, unknown>;
      const pb = (b.publication ?? {}) as Record<string, unknown>;
      const ta = String(pa.publishedAt ?? a.builtAt ?? a.publishedAt ?? '');
      const tb = String(pb.publishedAt ?? b.builtAt ?? b.publishedAt ?? '');
      return tb.localeCompare(ta);
    });

    return {
      history: uniquePubs.slice(0, 200),
      historyByName: Object.fromEntries(historyByName.entries())
    };
  })();

  return {
    pipeline,
    captures,
    collections,
    materializations,
    // NOT awaited — SvelteKit streams this promise; the page renders instantly
    // and any {#await} block in the template shows the skeleton until it resolves.
    streamed
  };
};
