import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError, type LogRow } from '$lib/server/flowctl';
import { sampleLogs } from '$lib/server/logs';

export const GET = async ({ url }) => {
  const task = url.searchParams.get('task');
  const since = url.searchParams.get('since') ?? '7d';
  if (!task) throw error(400, 'missing task');
  try {
    const rows = await flowctl<LogRow[]>(['logs', '--task', task, '--since', since, '-o', 'json']);
    return json(sampleLogs(rows));
  } catch (e) {
    if (e instanceof FlowctlError) throw error(502, `${e.message}\n${e.stderr}`);
    throw e;
  }
};
