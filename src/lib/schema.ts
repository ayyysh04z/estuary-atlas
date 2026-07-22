// Flatten a JSON Schema into rows for tabular display.
// Mirrors viewer/build.py flattenSchema logic.

export interface SchemaRow {
  path: string;
  depth: number;
  type: string;
  format: string;
  required: boolean;
  nullable: boolean;
  constraints: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(node: Obj): { type: string; nullable: boolean } {
  const t = node['type'];
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null');
    return { type: nonNull.join('|') || 'any', nullable: t.includes('null') };
  }
  if (typeof t === 'string') return { type: t, nullable: false };
  if (node['properties']) return { type: 'object', nullable: false };
  if (node['items']) return { type: 'array', nullable: false };
  return { type: 'any', nullable: false };
}

function constraintsOf(node: Obj): string {
  const parts: string[] = [];
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'enum']) {
    if (node[k] !== undefined) {
      const v = node[k];
      parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  for (const k of Object.keys(node)) {
    if (k.startsWith('x-str-') || k === 'x-infer-schema') {
      parts.push(`${k}=${JSON.stringify(node[k])}`);
    }
  }
  return parts.join(' ');
}

/**
 * Resolve a JSON Schema wrapper commonly seen from `flowctl catalog history --models`:
 *   { $defs: { 'flow://inferred-schema': {...actual schema...} }, $ref: 'flow://inferred-schema' }
 *   { $defs: { 'flow://connector-schema': {...} }, allOf: [{ $ref: 'flow://connector-schema' }, {...more...}] }
 *
 * Returns a merged schema with `properties` / `required` / `additionalProperties` populated
 * from resolving `$ref` and merging `allOf`.
 */
export function resolveSchema(schema: unknown): Obj | null {
  if (!isObj(schema)) return null;
  const defs = (schema['$defs'] as Obj | undefined) ?? {};

  const resolveRef = (ref: unknown): Obj | null => {
    if (typeof ref !== 'string') return null;
    // Try direct hit in $defs by key
    if (defs[ref] && isObj(defs[ref])) return defs[ref] as Obj;
    // Try common Estuary keys
    for (const k of Object.keys(defs)) {
      if (k === ref || ref.includes(k) || k.includes(ref.split('/').pop() ?? '')) {
        if (isObj(defs[k])) return defs[k] as Obj;
      }
    }
    return null;
  };

  const merge = (target: Obj, source: Obj): void => {
    for (const [k, v] of Object.entries(source)) {
      if (k === '$defs' || k === '$ref' || k === '$id') continue;
      if (k === 'properties' && isObj(v) && isObj(target[k])) {
        target[k] = { ...(target[k] as Obj), ...v };
      } else if (k === 'required' && Array.isArray(v)) {
        const cur = Array.isArray(target[k]) ? (target[k] as string[]) : [];
        target[k] = Array.from(new Set([...cur, ...(v as string[])]));
      } else if (target[k] === undefined) {
        target[k] = v;
      }
    }
  };

  const out: Obj = {};
  // If schema has properties directly, use it as the base
  if (isObj(schema['properties'])) merge(out, schema);
  // Resolve top-level $ref
  if (schema['$ref']) {
    const target = resolveRef(schema['$ref']);
    if (target) merge(out, target);
  }
  // Merge each allOf branch
  if (Array.isArray(schema['allOf'])) {
    for (const branch of schema['allOf'] as unknown[]) {
      if (!isObj(branch)) continue;
      if (branch['$ref']) {
        const target = resolveRef(branch['$ref']);
        if (target) merge(out, target);
      } else {
        merge(out, branch);
      }
    }
  }
  // Fallback: if we resolved nothing but $defs has exactly one, use it
  if (!isObj(out['properties']) && Object.keys(defs).length === 1) {
    const only = Object.values(defs)[0];
    if (isObj(only)) merge(out, only);
  }
  return isObj(out['properties']) || isObj(out['additionalProperties']) ? out : null;
}

export function flattenSchema(schema: unknown, maxDepth = 4): SchemaRow[] {
  const rows: SchemaRow[] = [];
  const root = resolveSchema(schema) ?? (isObj(schema) ? schema : null);
  if (!root) return rows;

  function walk(node: Obj, path: string, depth: number): void {
    if (depth > maxDepth) return;
    let resolved = node;
    if (node['$ref'] || node['allOf']) {
      const r = resolveSchema(node);
      if (r) resolved = r;
    }
    const props = resolved['properties'];
    if (!isObj(props)) return;
    const req = new Set<string>(
      Array.isArray(resolved['required']) ? (resolved['required'] as string[]) : []
    );
    for (const [name, rawChild] of Object.entries(props)) {
      if (!isObj(rawChild)) continue;
      const child = rawChild;
      const childPath = path ? `${path}.${name}` : name;
      const { type, nullable } = typeOf(child);
      rows.push({
        path: childPath,
        depth,
        type,
        format: String(child['format'] ?? ''),
        required: req.has(name),
        nullable,
        constraints: constraintsOf(child)
      });
      if (child['properties']) {
        walk(child, childPath, depth + 1);
      } else if (child['items'] && isObj(child['items']) && (child['items'] as Obj)['properties']) {
        walk(child['items'] as Obj, `${childPath}[]`, depth + 1);
      }
    }
  }

  walk(root, '', 0);
  return rows;
}
