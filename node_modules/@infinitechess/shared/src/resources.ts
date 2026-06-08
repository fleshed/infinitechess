import {
  RESOURCE_HIDDEN_DENOM,
  RESOURCE_SEED,
  RESOURCE_VISIBLE_DENOM,
  RESOURCE_YIELD_MAX,
  RESOURCE_YIELD_MIN,
} from './constants.js';
import type { ResourceKind } from './types.js';

/** Deterministic 32-bit integer hash of (x, y, salt). Output is treated as
 *  an unsigned 32-bit integer; consumers reduce modulo a denom or scale
 *  to a [0,1) float. The avalanche steps are the standard xorshift mix
 *  from Bret Mulvey — overkill for resource placement but cheap and gives
 *  a near-uniform distribution across the signed 32-bit coordinate space. */
function hash3(x: number, y: number, salt: number): number {
  let h = (x | 0) * 0x1f1f1f1f;
  h ^= (y | 0) * 0x85ebca6b;
  h ^= (salt | 0) * 0xc2b2ae35;
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** True iff (x,y) is a Visible Resource square. Stable across all
 *  clients and the server (same hash, same seed). */
export function isVisibleResource(x: number, y: number): boolean {
  return hash3(x, y, RESOURCE_SEED ^ 0xAA01) % RESOURCE_VISIBLE_DENOM === 0;
}

/** True iff (x,y) is a Hidden Resource square. Hidden rolls are only
 *  consulted on cells that did NOT already roll Visible — guarantees a
 *  cell is exactly one of: visible, hidden, or none. */
export function isHiddenResource(x: number, y: number): boolean {
  if (isVisibleResource(x, y)) return false;
  return hash3(x, y, RESOURCE_SEED ^ 0xBB02) % RESOURCE_HIDDEN_DENOM === 0;
}

/** Returns the kind of resource at (x,y), or `null` if none. */
export function resourceKindAt(x: number, y: number): ResourceKind | null {
  if (isVisibleResource(x, y)) return 'visible';
  if (hash3(x, y, RESOURCE_SEED ^ 0xBB02) % RESOURCE_HIDDEN_DENOM === 0) return 'hidden';
  return null;
}

/** Currency/s a resource at (x,y) produces. Integer in [MIN, MAX]. The
 *  yield is independent of kind so visible and hidden squares share the
 *  same payout distribution. */
export function resourceYieldAt(x: number, y: number): number {
  const range = RESOURCE_YIELD_MAX - RESOURCE_YIELD_MIN + 1;
  return RESOURCE_YIELD_MIN + (hash3(x, y, RESOURCE_SEED ^ 0xCC03) % range);
}
