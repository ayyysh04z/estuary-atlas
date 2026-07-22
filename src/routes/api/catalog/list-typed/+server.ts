import { error, json } from '@sveltejs/kit';
import { flowctl, FlowctlError, type CatalogListItem } from '$lib/server/flowctl';

const ALLOWED = new Set(['captures', 'collections', 'materializations']);

export const GET = async ({ url }) => {
  const prefix = url.searchParams.get('prefix');
  const type = url.searchParams.get('type');
  if (!prefix) throw error(400, 'missing prefix');
  if (!type || !ALLOWED.has(type)) throw error(400, 'invalid type');
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
    return json(items);
  } catch (e) {
    if (e instanceof FlowctlError) throw error(502, `${e.message}\n${e.stderr}`);
    throw e;
  }
};
