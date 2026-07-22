import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getPipeline } from '$lib/pipelines';
import { flowctl, type HistoryEvent } from '$lib/server/flowctl';

export const load: PageServerLoad = async ({ params }) => {
  const pipeline = getPipeline(params.pipeline);
  if (!pipeline) throw error(404, 'unknown pipeline');
  const specName = params.spec;
  if (!specName) throw error(400, 'missing spec');

  let events: HistoryEvent[] = [];
  try {
    events = await flowctl<HistoryEvent[]>([
      'catalog',
      'history',
      '--name',
      specName,
      '--models',
      '-o',
      'json'
    ]);
  } catch (e) {
    return {
      pipeline,
      specName,
      events: [] as HistoryEvent[],
      error: e instanceof Error ? e.message : String(e)
    };
  }

  // Sort newest first (flowctl returns oldest first).
  events.sort((a, b) => {
    const pa = (a.publication ?? {}) as Record<string, unknown>;
    const pb = (b.publication ?? {}) as Record<string, unknown>;
    const ta = String(pa.publishedAt ?? '');
    const tb = String(pb.publishedAt ?? '');
    return tb.localeCompare(ta);
  });

  return { pipeline, specName, events };
};
