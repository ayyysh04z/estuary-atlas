import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError, type CatalogListItem } from '$lib/server/flowctl';

export const GET = async ({ url }) => {
  const prefix = url.searchParams.get('prefix');
  if (!prefix) throw error(400, 'missing prefix');
  try {
    const items = await flowctl<CatalogListItem[]>(['catalog', 'list', '--prefix', prefix, '-o', 'json']);
    return json(items);
  } catch (e) {
    if (e instanceof FlowctlError) throw error(502, `${e.message}\n${e.stderr}`);
    throw e;
  }
};
