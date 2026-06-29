/**
 * A tiny, zero-dependency YAML *emitter* for the OpenAPI document.
 *
 * The spec's single source of truth is the typed object in `openapi.ts`; this serialises it
 * to block-style YAML so a human-readable `bridge/openapi.yaml` can be committed for repo
 * viewers, with a test asserting the committed file matches a fresh emit (no drift). We emit
 * (not parse) deliberately: emitting a known, JSON-shaped object is simple and safe, whereas
 * parsing arbitrary YAML would need a real dependency (CLAUDE.md: minimal dependency surface).
 *
 * Strings are always double-quoted via `JSON.stringify` — a JSON string literal is also a
 * valid YAML double-quoted scalar — so escaping is correct by construction.
 */
import type { JsonValue } from './openapi.ts';

/** Serialise a JSON-shaped object to block-style YAML (trailing newline included). */
export function emitYaml(root: JsonValue): string {
  const out: string[] = [];
  if (isScalar(root)) {
    out.push(scalar(root));
  } else if (isJsonArray(root)) {
    emitArrayBody(out, root, 0);
  } else {
    emitObjectBody(out, root, 0);
  }
  return out.join('\n') + '\n';
}

function isScalar(value: JsonValue): value is string | number | boolean | null {
  return value === null || typeof value !== 'object';
}

/** Typed array check whose predicate narrows the *negative* branch (unlike `Array.isArray`
 * on a `readonly` array type, which leaves it in the union). */
function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function pad(indent: number): string {
  return '  '.repeat(indent);
}

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

/** A key is emitted bare when it is a safe plain scalar, else double-quoted. */
function keyToken(key: string): string {
  const safe = /^[A-Za-z_./{}$][A-Za-z0-9_./{}$-]*$/.test(key);
  return safe ? key : JSON.stringify(key);
}

function emitObjectBody(out: string[], obj: { readonly [k: string]: JsonValue }, indent: number): void {
  for (const [k, v] of Object.entries(obj)) {
    const key = keyToken(k);
    if (isScalar(v)) {
      out.push(`${pad(indent)}${key}: ${scalar(v)}`);
    } else if (isJsonArray(v)) {
      if (v.length === 0) out.push(`${pad(indent)}${key}: []`);
      else {
        out.push(`${pad(indent)}${key}:`);
        emitArrayBody(out, v, indent);
      }
    } else {
      if (Object.keys(v).length === 0) out.push(`${pad(indent)}${key}: {}`);
      else {
        out.push(`${pad(indent)}${key}:`);
        emitObjectBody(out, v, indent + 1);
      }
    }
  }
}

function emitArrayBody(out: string[], arr: readonly JsonValue[], indent: number): void {
  for (const v of arr) {
    if (isScalar(v)) {
      out.push(`${pad(indent)}- ${scalar(v)}`);
    } else if (isJsonArray(v)) {
      if (v.length === 0) out.push(`${pad(indent)}- []`);
      else {
        out.push(`${pad(indent)}-`);
        emitArrayBody(out, v, indent + 1);
      }
    } else {
      if (Object.keys(v).length === 0) out.push(`${pad(indent)}- {}`);
      else {
        out.push(`${pad(indent)}-`);
        emitObjectBody(out, v, indent + 1);
      }
    }
  }
}
