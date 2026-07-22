import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError, type CatalogListItem } from '$lib/server/flowctl';

export const GET = async ({ url }) => {
  const prefix = url.searchParams.get('prefix');
  if (!prefix) throw error(400, 'missing prefix');
  try {
    const items = await flowctl<CatalogListItem[]>([
      'catalog',
      'list',
      '--prefix',
      prefix,
      '-o',
      'json'
    ]);
    const byType: Record<string, number> = { capture: 0, collection: 0, materialization: 0 };
    let ok = 0;
    let disabled = 0;
    for (const it of items) {
      const t = String(it.type ?? '').toLowerCase();
      if (t.includes('capture')) byType.capture++;
      else if (t.includes('collection')) byType.collection++;
      else if (t.includes('materialization')) byType.materialization++;
      const shard = it['shardStatus'] ?? it['status'];
      if (shard === 'DISABLED' || it['disabled'] === true) disabled++;
      else ok++;
    }
    return json({ ok, disabled, byType, total: items.length });
  } catch (e) {
    if (e instanceof FlowctlError) {
      return json({ error: e.message, stderr: e.stderr }, { status: 502 });
    }
    throw e;
  }
};
