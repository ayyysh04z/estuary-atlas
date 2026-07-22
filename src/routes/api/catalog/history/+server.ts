import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError, type HistoryEvent } from '$lib/server/flowctl';

export const GET = async ({ url }) => {
  const name = url.searchParams.get('name');
  const includeModels = url.searchParams.get('models') === '1';
  if (!name) throw error(400, 'missing name');
  const args = ['catalog', 'history', '--name', name, '-o', 'json'];
  if (includeModels) args.push('--models');
  try {
    const events = await flowctl<HistoryEvent[]>(args);
    return json(events);
  } catch (e) {
    if (e instanceof FlowctlError) throw error(502, `${e.message}\n${e.stderr}`);
    throw e;
  }
};
