import {
  PATHFIND_DETOUR_BUDGET,
  PATHFIND_MAX_NODES,
  bishopCanReach,
  coordEq,
  coordKey,
  distanceFor,
  enumerateMoves,
  type Coord,
  type Occupant,
  type Piece,
} from '@infinitechess/shared';

/**
 * Plan the next single move for `piece` on its way to `goal`.
 *
 * Strategy:
 *
 *   1. **Greedy step.** Pick the legal move that lands closest to the goal
 *      under the piece's natural distance metric. If a move lands on the goal
 *      take it; if any move strictly improves on our current distance, take
 *      it. This makes progress at O(neighbors) per call on open boards.
 *
 *   2. **A* detour.** If greedy can't improve (a wall of friendlies, the
 *      knight's near-goal stutter, etc.) run an A* with the piece's distance
 *      metric as the heuristic. Nodes are pruned if `g + h` exceeds the
 *      current heuristic by more than `PATHFIND_DETOUR_BUDGET`, and total
 *      expansions are capped at `PATHFIND_MAX_NODES` — so the search cost is
 *      bounded per tick even on pathological terrain.
 */
export function pathfindNextMove(
  piece: Piece,
  goal: Coord,
  getOccupant: (c: Coord) => Occupant,
  /** Square the piece just came from. Excluded as a legal next step to prevent
   *  greedy/A* from undoing each other's progress. Pass null for fresh planning. */
  forbidden: Coord | null = null,
  /** Tie-break predicate: when two greedy candidates reduce distance equally,
   *  prefer the one for which `preferEmpty(square)` returns true. Used by the
   *  caller to deprioritize squares currently held by a friendly piece (even
   *  one that is vacating this tick) — so a king escaping diagonally doesn't
   *  visibly telegraph through a pawn's current square when a truly-empty
   *  diagonal alternative exists. */
  preferEmpty: ((c: Coord) => boolean) | null = null,
): Coord | null {
  if (coordEq(piece.pos, goal)) return null;
  if (piece.type === 'bishop' && !bishopCanReach(piece.pos, goal)) return null;

  const rawMoves = enumerateMoves(piece.type, piece.level, piece.pos, getOccupant);
  const moves = forbidden ? rawMoves.filter((m) => !coordEq(m, forbidden)) : rawMoves;
  if (DEBUG_PATHFIND) {
    const occ = moves.map((m) => `(${m.x},${m.y})`).join(' ');
    const fb = forbidden ? ` forbidden=(${forbidden.x},${forbidden.y})` : '';
    console.log(`[plan] ${piece.type} ${tag(piece)} pos=(${piece.pos.x},${piece.pos.y}) goal=(${goal.x},${goal.y})${fb} moves=[${occ}]`);
  }
  if (moves.length === 0) return null;

  // (1) Greedy. On a distance tie, prefer the move that the caller marks as
  // "empty" (typically: no friendly piece currently sits there). This stops
  // a king from queuing a telegraph into a square a pawn is vacating when a
  // genuinely-empty diagonal step is just as good.
  const currentDist = distanceFor(piece.type, piece.pos, goal);
  let best: Coord | null = null;
  let bestDist = Infinity;
  let bestPref = false;
  for (const m of moves) {
    if (coordEq(m, goal)) {
      if (DEBUG_PATHFIND) console.log(`[plan]   -> greedy reaches goal`);
      return m;
    }
    const d = distanceFor(piece.type, m, goal);
    const pref = preferEmpty ? preferEmpty(m) : true;
    if (d < bestDist || (d === bestDist && pref && !bestPref)) {
      bestDist = d;
      bestPref = pref;
      best = m;
    }
  }
  if (best && bestDist < currentDist) {
    if (DEBUG_PATHFIND) console.log(`[plan]   -> greedy step (${best.x},${best.y}) dist ${currentDist}->${bestDist}`);
    return best;
  }

  // (2) A* — only reached when greedy is stuck.
  const step = aStarFirstMove(piece, goal, getOccupant, currentDist, forbidden);
  if (DEBUG_PATHFIND) {
    if (step) console.log(`[plan]   -> A* step (${step.x},${step.y})`);
    else console.log(`[plan]   -> A* FAILED, no path; goal will be cancelled`);
  }
  return step;
}

/** Server-side debug toggle (env DEBUG_PATHFIND=1 to enable). */
const DEBUG_PATHFIND = process.env.DEBUG_PATHFIND === '1';
function tag(piece: Piece): string {
  return `[${piece.id.slice(0, 4)}]`;
}

/**
 * Pure reachability check: does a legal sequence of single moves exist from
 * `piece.pos` to `goal` given current occupancy? Used by the server to reject
 * goals up-front so a piece never accepts a job it can't finish.
 *
 * Costs one A* expansion budget. The greedy short-circuit is intentionally
 * skipped — greedy can't prove reachability of distant goals.
 */
export function isGoalReachable(
  piece: Piece,
  goal: Coord,
  getOccupant: (c: Coord) => Occupant,
): boolean {
  if (coordEq(piece.pos, goal)) return true;
  if (piece.type === 'bishop' && !bishopCanReach(piece.pos, goal)) return false;
  if (enumerateMoves(piece.type, piece.level, piece.pos, getOccupant).length === 0) return false;
  const startDist = distanceFor(piece.type, piece.pos, goal);
  return aStarFirstMove(piece, goal, getOccupant, startDist) !== null;
}

interface Node {
  pos: Coord;
  firstMove: Coord | null;
  g: number;
  f: number;
}

function aStarFirstMove(
  piece: Piece,
  goal: Coord,
  getOccupant: (c: Coord) => Occupant,
  startDist: number,
  forbidden: Coord | null = null,
): Coord | null {
  // Treat the start square as empty during search (we are leaving it).
  const occAt = (c: Coord): Occupant => (coordEq(c, piece.pos) ? 'empty' : getOccupant(c));
  const heuristic = (c: Coord) => distanceFor(piece.type, c, goal);
  /** Hard cap on f = g + h. Lets A* take detours up to BUDGET steps over the straight-line minimum. */
  const fCap = startDist + PATHFIND_DETOUR_BUDGET;

  const open = new MinHeap<Node>((n) => n.f);
  open.push({ pos: piece.pos, firstMove: null, g: 0, f: startDist });

  /** Best g-cost ever reached for each square. */
  const bestG = new Map<string, number>();
  bestG.set(coordKey(piece.pos), 0);
  // Pre-block the forbidden square so we never even consider it as a first step.
  if (forbidden) bestG.set(coordKey(forbidden), 0);

  let expanded = 0;
  while (open.size() > 0) {
    const node = open.pop()!;
    if (++expanded > PATHFIND_MAX_NODES) break;

    // Stale entry (we already reached this square cheaper).
    const seenG = bestG.get(coordKey(node.pos));
    if (seenG !== undefined && seenG < node.g) continue;

    for (const m of enumerateMoves(piece.type, piece.level, node.pos, occAt)) {
      if (forbidden && node.firstMove === null && coordEq(m, forbidden)) continue;
      const firstMove = node.firstMove ?? m;
      if (coordEq(m, goal)) return firstMove;

      const g = node.g + 1;
      const h = heuristic(m);
      const f = g + h;
      if (f > fCap) continue;

      const k = coordKey(m);
      const prev = bestG.get(k);
      if (prev !== undefined && prev <= g) continue;
      bestG.set(k, g);

      open.push({ pos: m, firstMove, g, f });
    }
  }
  // No complete path within the search budget — give up cleanly. The caller
  // (World.tryQueueNextMove) will drop the goal, so the piece visibly stops
  // instead of fidgeting against a wall it can't get through.
  return null;
}

/** Tiny binary min-heap. Avoids the O(N) cost of repeated sorts on the open list. */
class MinHeap<T> {
  private data: T[] = [];
  constructor(private key: (v: T) => number) {}
  size(): number { return this.data.length; }
  push(v: T): void {
    this.data.push(v);
    let i = this.data.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.key(this.data[i]!) >= this.key(this.data[parent]!)) break;
      [this.data[i], this.data[parent]] = [this.data[parent]!, this.data[i]!];
      i = parent;
    }
  }
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0]!;
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let i = 0;
      const n = this.data.length;
      while (true) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let smallest = i;
        if (l < n && this.key(this.data[l]!) < this.key(this.data[smallest]!)) smallest = l;
        if (r < n && this.key(this.data[r]!) < this.key(this.data[smallest]!)) smallest = r;
        if (smallest === i) break;
        [this.data[i], this.data[smallest]] = [this.data[smallest]!, this.data[i]!];
        i = smallest;
      }
    }
    return top;
  }
}
