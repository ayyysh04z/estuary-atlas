// Port of chip classification from viewer/build.py.
// A chip has a label and a kind: 'default' | 'modified' | 'info'.

export type ChipKind = 'default' | 'modified' | 'info' | 'danger';
export interface Chip {
  label: string;
  kind: ChipKind;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Classify a collection writeSchema. */
export function classifyWriteSchema(ws: unknown): string {
  if (!ws) return 'none';
  if (typeof ws === 'string') return 'file-reference';
  if (isObj(ws)) {
    const ref = ws['$ref'];
    if (typeof ref === 'string' && ref.includes('flow://')) return 'connector-default';
    if (Array.isArray(ws['allOf']) || 'properties' in ws || 'type' in ws) return 'inline-custom';
  }
  return 'unknown';
}

/** Classify a collection readSchema. */
export function classifyReadSchema(rs: unknown): { klass: string; strict: boolean } {
  if (!rs) return { klass: 'none', strict: false };
  if (typeof rs === 'string') {
    return { klass: rs.includes('inferred') ? 'inferred' : 'custom', strict: false };
  }
  if (isObj(rs)) {
    const strict = rs['additionalProperties'] === false;
    return { klass: 'inline-custom', strict };
  }
  return { klass: 'unknown', strict: false };
}

export function captureChips(body: Obj): Chip[] {
  const chips: Chip[] = [];
  const auto = (body['autoDiscover'] as Obj | undefined) ?? null;
  if (auto && (auto['addNewBindings'] || auto['evolveIncompatibleCollections'])) {
    chips.push({ label: 'autoDiscover', kind: 'modified' });
  } else {
    chips.push({ label: 'autoDiscover-off', kind: 'modified' });
  }
  const shards = (body['shards'] as Obj | undefined) ?? {};
  const flags = (shards['flags'] as Obj | undefined) ?? {};
  const rv2 = flags['enable-runtime-v2'];
  if (rv2 === true || rv2 === 'true') {
    chips.push({ label: 'runtime-v2', kind: 'modified' });
  }
  return chips;
}

export function collectionChips(body: Obj): Chip[] {
  const chips: Chip[] = [];
  const ws = body['writeSchema'];
  const rs = body['readSchema'];
  const key = (body['key'] as string[] | undefined) ?? [];
  const wsClass = classifyWriteSchema(ws);
  const rsInfo = rs ? classifyReadSchema(rs) : { klass: 'none', strict: false };

  if (rsInfo.klass === 'inferred') chips.push({ label: 'inferred-read', kind: 'modified' });
  else if (rsInfo.klass === 'custom') chips.push({ label: 'custom-read', kind: 'modified' });
  else if (rsInfo.klass === 'inline-custom') chips.push({ label: 'inline-schema', kind: 'modified' });
  else chips.push({ label: 'default-read', kind: 'default' });

  if (wsClass === 'connector-default') chips.push({ label: 'connector-write', kind: 'default' });
  else if (wsClass === 'file-reference' || wsClass === 'inline-custom') {
    chips.push({ label: 'custom-write', kind: 'modified' });
  }

  if (rsInfo.strict) chips.push({ label: 'strict-props', kind: 'modified' });
  if (key.some((k) => k.startsWith('/_meta/'))) chips.push({ label: 'synthetic-key', kind: 'info' });
  if (key.length > 1) chips.push({ label: `composite-key×${key.length}`, kind: 'info' });
  return chips;
}

export function materializationChips(body: Obj): Chip[] {
  const chips: Chip[] = [];
  const src = (body['source'] as Obj | undefined) ?? {};
  const bindings = (body['bindings'] as Obj[] | undefined) ?? [];
  if (src['deltaUpdates']) chips.push({ label: 'deltaUpdates', kind: 'modified' });
  const pinned = bindings.filter((b) => {
    const fields = (b['fields'] as Obj | undefined) ?? {};
    return isObj(fields['require']);
  }).length;
  if (pinned) chips.push({ label: `pinned-fields×${pinned}`, kind: 'modified' });
  const delta = bindings.filter((b) => {
    const res = (b['resource'] as Obj | undefined) ?? {};
    return res['delta_updates'];
  }).length;
  if (delta) chips.push({ label: `delta×${delta}`, kind: 'modified' });
  const excluded = bindings.filter((b) => {
    const fields = (b['fields'] as Obj | undefined) ?? {};
    return Array.isArray(fields['exclude']) && (fields['exclude'] as unknown[]).length > 0;
  }).length;
  if (excluded) chips.push({ label: `excluded×${excluded}`, kind: 'modified' });
  return chips;
}

/**
 * Given a history event with publication.model containing captures/collections/materializations,
 * extract the primary spec body for a catalog name.
 */
export function extractSpecBody(
  model: Record<string, unknown> | undefined,
  catalogName: string,
  catalogType?: string
): { kind: 'capture' | 'collection' | 'materialization'; body: Obj } | null {
  if (!model) return null;
  // Case A: `flowctl catalog history --models` returns the spec body directly.
  // Detect via known field markers, or use catalogType if the caller supplied it.
  const looksLikeCollection = 'writeSchema' in model || 'readSchema' in model;
  const endpoint = model['endpoint'] as Obj | undefined;
  const image = String((endpoint?.['connector'] as Obj | undefined)?.['image'] ?? '');
  const looksLikeCapture = image.includes('source-') || (Array.isArray(model['bindings']) && !image.includes('materialize-'));
  const looksLikeMaterialization = image.includes('materialize-');

  const inferredKind: 'capture' | 'collection' | 'materialization' | null =
    (catalogType as 'capture' | 'collection' | 'materialization' | undefined) ??
    (looksLikeCollection ? 'collection'
      : looksLikeMaterialization ? 'materialization'
      : looksLikeCapture ? 'capture'
      : null);

  if (inferredKind && (looksLikeCollection || looksLikeCapture || looksLikeMaterialization)) {
    return { kind: inferredKind, body: model };
  }

  // Case B: legacy wrapped shape { captures: {name: body}, collections: {...}, materializations: {...} }
  const captures = (model['captures'] as Obj | undefined) ?? {};
  if (captures[catalogName]) return { kind: 'capture', body: captures[catalogName] as Obj };
  const collections = (model['collections'] as Obj | undefined) ?? {};
  if (collections[catalogName]) return { kind: 'collection', body: collections[catalogName] as Obj };
  const mats = (model['materializations'] as Obj | undefined) ?? {};
  if (mats[catalogName]) return { kind: 'materialization', body: mats[catalogName] as Obj };
  return null;
}
