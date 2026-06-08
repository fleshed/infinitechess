import type { Coord, Piece, PieceLevel, PieceType } from './types.js';
import {
  PAWN_MOVE_RANGE_L2,
  SLIDER_MAX_RANGE_L1,
  SLIDER_MAX_RANGE_L2,
} from './constants.js';

export function coordEq(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

export function coordKey(c: Coord): string {
  return `${c.x},${c.y}`;
}

export function chebyshev(a: Coord, b: Coord): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function manhattan(a: Coord, b: Coord): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function euclidean(a: Coord, b: Coord): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Exact knight-distance (number of L-shaped jumps) between two squares on
 * an infinite board. Closed-form formula — O(1), admissible for A*, and
 * monotone, so greedy descent on this metric actually makes progress
 * instead of bouncing the knight around an adjacent target.
 *
 * Without this, A* with a Euclidean heuristic over-estimates remaining
 * cost (one knight jump covers ~2.24 Euclidean units) which makes the
 * heuristic inadmissible and lets A* return wildly suboptimal first
 * steps for short goals like "move to the adjacent square".
 */
export function knightDistance(a: Coord, b: Coord): number {
  let dx = Math.abs(a.x - b.x);
  let dy = Math.abs(a.y - b.y);
  if (dx < dy) { const t = dx; dx = dy; dy = t; }    // dx >= dy
  if (dx === 1 && dy === 0) return 3;                // single-step neighbor
  if (dx === 2 && dy === 2) return 4;                // diagonal-2 (the other awkward case)
  const delta = dx - dy;
  if (dy > delta) return delta - 2 * Math.floor((delta - dy) / 3);
  return delta - 2 * Math.floor((delta - dy) / 4);
}

/**
 * Distance heuristic appropriate for each piece's movement pattern. Used by
 * the server's greedy pathfinder to score candidate moves toward a goal.
 *
 * The metric matches how the piece actually traverses space:
 *   - pawn: Manhattan (orthogonal steps)
 *   - king, rook, bishop, queen: Chebyshev (one move covers diagonal + ortho)
 *   - knight: exact infinite-board knight distance (closed-form, admissible)
 */
export function distanceFor(type: PieceType, a: Coord, b: Coord): number {
  switch (type) {
    case 'pawn': return manhattan(a, b);
    case 'knight': return knightDistance(a, b);
    default: return chebyshev(a, b);
  }
}

// --- Direction vectors ---

const ORTHO: readonly Coord[] = [
  { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
];
const DIAG: readonly Coord[] = [
  { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
];
const ALL8: readonly Coord[] = [...ORTHO, ...DIAG];
const KNIGHT: readonly Coord[] = [
  { x: 2, y: 1 }, { x: 2, y: -1 }, { x: -2, y: 1 }, { x: -2, y: -1 },
  { x: 1, y: 2 }, { x: 1, y: -2 }, { x: -1, y: 2 }, { x: -1, y: -2 },
];

export interface MovementRules {
  /** Directions in which the piece may move to an empty square. */
  moveDirs: readonly Coord[];
  /** Directions in which the piece may capture an enemy. */
  captureDirs: readonly Coord[];
  /** Maximum squares per single move (1 for steppers, more for sliders).
   *  When `captureRange` is omitted, this applies to both move and capture
   *  directions; when present, this is the move range and `captureRange`
   *  applies to captures. Pawn L2 uses this asymmetry: 2-square move,
   *  1-square diagonal capture. */
  maxRange: number;
  /** Optional capture-direction range override. Used only for pieces whose
   *  L2+ ability extends move-range but NOT capture-range (pawn L2). */
  captureRange?: number;
  /** Jumping pieces ignore intermediate occupants (knight). */
  isJump: boolean;
}

export function rulesFor(type: PieceType, level: PieceLevel): MovementRules {
  switch (type) {
    case 'pawn':
      if (level >= 2) {
        return {
          moveDirs: ORTHO,
          captureDirs: DIAG,
          maxRange: PAWN_MOVE_RANGE_L2,
          captureRange: 1,
          isJump: false,
        };
      }
      return { moveDirs: ORTHO, captureDirs: DIAG, maxRange: 1, isJump: false };
    case 'king':
      // L2 king castling is a special move sequence handled outside the
      // generic enumerateMoves pipeline; the base rules stay 1-step.
      return { moveDirs: ALL8, captureDirs: ALL8, maxRange: 1, isJump: false };
    case 'knight':
      // L2 knight feint is a tactical override resolved in the combat
      // system; the base movement stays the classic L-jump.
      return { moveDirs: KNIGHT, captureDirs: KNIGHT, maxRange: 1, isJump: true };
    case 'bishop': {
      const r = level >= 2 ? SLIDER_MAX_RANGE_L2 : SLIDER_MAX_RANGE_L1;
      return { moveDirs: DIAG, captureDirs: DIAG, maxRange: r, isJump: false };
    }
    case 'rook': {
      const r = level >= 2 ? SLIDER_MAX_RANGE_L2 : SLIDER_MAX_RANGE_L1;
      return { moveDirs: ORTHO, captureDirs: ORTHO, maxRange: r, isJump: false };
    }
    case 'queen': {
      const r = level >= 2 ? SLIDER_MAX_RANGE_L2 : SLIDER_MAX_RANGE_L1;
      return { moveDirs: ALL8, captureDirs: ALL8, maxRange: r, isJump: false };
    }
  }
}

export type Occupant = 'empty' | 'friendly' | 'enemy' | 'blocked';

/**
 * Enumerate every square the piece (at `from`) can legally move to in a single
 * move, given an occupancy lookup. Includes capture squares.
 */
export function enumerateMoves(
  type: PieceType,
  level: PieceLevel,
  from: Coord,
  getOccupant: (c: Coord) => Occupant,
): Coord[] {
  const rules = rulesFor(type, level);
  const out: Coord[] = [];
  const moveDirKeys = new Set(rules.moveDirs.map((d) => `${d.x},${d.y}`));
  const captureDirKeys = new Set(rules.captureDirs.map((d) => `${d.x},${d.y}`));
  const allDirs = new Map<string, Coord>();
  for (const d of rules.moveDirs) allDirs.set(`${d.x},${d.y}`, d);
  for (const d of rules.captureDirs) allDirs.set(`${d.x},${d.y}`, d);

  for (const [key, d] of allDirs) {
    const canMove = moveDirKeys.has(key);
    const canCapture = captureDirKeys.has(key);
    const moveMax = rules.maxRange;
    const captureMax = rules.captureRange ?? rules.maxRange;
    const dirMax = Math.max(canMove ? moveMax : 0, canCapture ? captureMax : 0);
    for (let step = 1; step <= dirMax; step++) {
      const c: Coord = { x: from.x + d.x * step, y: from.y + d.y * step };
      const occ = getOccupant(c);
      if (rules.isJump) {
        if (occ === 'empty' && canMove && step <= moveMax) out.push(c);
        else if (occ === 'enemy' && canCapture && step <= captureMax) out.push(c);
        break;
      }
      if (occ === 'empty') {
        if (canMove && step <= moveMax) out.push(c);
        continue;
      }
      if (occ === 'enemy' && canCapture && step <= captureMax) out.push(c);
      break; // any non-empty square stops a non-jumping slide
    }
  }
  return out;
}

export function canMoveTo(
  piece: Piece,
  target: Coord,
  getOccupant: (c: Coord) => Occupant,
): boolean {
  return enumerateMoves(piece.type, piece.level, piece.pos, getOccupant)
    .some((m) => coordEq(m, target));
}

/** Bishops are confined to squares of one color. */
export function bishopCanReach(from: Coord, to: Coord): boolean {
  return ((from.x + from.y) & 1) === ((to.x + to.y) & 1);
}

/**
 * Pure-geometry check: can `defender` legally capture *onto* `target` in a
 * single move if the board were empty? Used for auto-recapture range validation
 * at assignment time. Respects `rulesFor(type, level)` so leveling extends it.
 */
export function canReachForCapture(
  type: PieceType,
  level: PieceLevel,
  from: Coord,
  target: Coord,
): boolean {
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  if (dx === 0 && dy === 0) return false;
  const rules = rulesFor(type, level);
  const captureMax = rules.captureRange ?? rules.maxRange;
  if (rules.isJump) {
    return rules.captureDirs.some((d) => d.x === dx && d.y === dy);
  }
  for (const d of rules.captureDirs) {
    // direction must align with (dx,dy)
    if ((d.x === 0) !== (dx === 0)) continue;
    if ((d.y === 0) !== (dy === 0)) continue;
    if (d.x !== 0 && Math.sign(d.x) !== Math.sign(dx)) continue;
    if (d.y !== 0 && Math.sign(d.y) !== Math.sign(dy)) continue;
    const stepX = Math.abs(dx);
    const stepY = Math.abs(dy);
    if (d.x !== 0 && d.y !== 0 && stepX !== stepY) continue;
    const steps = Math.max(stepX, stepY);
    if (steps >= 1 && steps <= captureMax) return true;
  }
  return false;
}

// Convenience: legality of a single move on an empty board (used by older callers/tests).
export function isLegalStep(
  type: PieceType,
  level: PieceLevel,
  from: Coord,
  to: Coord,
): boolean {
  return canMoveTo(
    { id: '', ownerId: '', type, level, pos: from, bornTick: 0 },
    to,
    () => 'empty',
  );
}
