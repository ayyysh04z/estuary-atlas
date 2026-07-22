import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError, type HistoryEvent } from '$lib/server/flowctl';

// Alias to catalog history --models (last event) — simpler and safer than
// catalog pull-specs (which writes files to disk).
export const GET = async ({ url }) => {
  const name = url.searchParams.get('name');
  if (!name) throw error(400, 'missing name');
  try {
    const events = await flowctl<HistoryEvent[]>([
      'catalog',
      'history',
      '--name',
      name,
      '--models',
      '-o',
      'json'
    ]);
    const latest = events[0];
    return json({ name, model: latest?.publication?.model ?? null });
  } catch (e) {
    if (e instanceof FlowctlError) {
      return json({ error: e.message, stderr: e.stderr }, { status: 502 });
    }
    throw e;
  }
};
