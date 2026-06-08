export type PieceType = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king';
export type PieceLevel = 1 | 2 | 3;
export type PlayerId = string;
export type PieceId = string;

export interface Coord {
  x: number;
  y: number;
}

export interface TelegraphedMove {
  from: Coord;
  to: Coord;
  startTick: number;
  endTick: number;
}

export interface Piece {
  id: PieceId;
  ownerId: PlayerId;
  type: PieceType;
  level: PieceLevel;
  pos: Coord;
  /** Active telegraphed single-step move (set by the server). */
  move?: TelegraphedMove;
  /** Player-requested destination. Server pathfinds toward it one move per tick. */
  goal?: Coord;
  /** Snapshot of `goal` taken when set by a coordinated player formation
   *  march. Compared by value to `goal` at planning time: if they match,
   *  the goal is part of a march and the planner uses lockstep ortho-
   *  collapse to keep the formation rigid; if they differ (any other
   *  goal-setter has overwritten `goal`), the goal is treated as solo
   *  and the natural pathfinder runs — so sliders use their full range
   *  on engagement, regroup, recapture, and king-safety retreats. */
  formationGoal?: Coord;
  /** Peers this piece has explicitly left a formation with (right-click
   *  Leave Formation, or ctrl-click move to a non-adjacent square). While
   *  these peers are still chebyshev-adjacent, `recomputeFormations` will
   *  not re-union this piece with them, and `regroupScan` will not pick
   *  them as a rally target. Entries auto-prune once their piece is no
   *  longer adjacent, so re-entering range allows a natural re-join. */
  formationLeft?: PieceId[];
  bornTick: number;
  /** Tick (exclusive) until which this piece is intimidated/frozen and cannot plan a move. */
  frozenUntilTick?: number;
  /** Shared id of the formation this piece belongs to (auto-computed server-side from recapture eligibility + pawn stickiness). Undefined when the piece is alone. */
  formationId?: string;
  /** Rest-pose offset from the formation's anchor (smallest-id member), captured the last time the formation was at rest. Used by `formationMove` to preserve original shape across mid-march retargets. */
  slotOffset?: Coord;
  /** `formationId` the `slotOffset` was captured against. When this differs from the current `formationId`, the slot is stale and will be refreshed next time the group is at rest. */
  formationSlotId?: string;
  /** Persistent original-formation id, captured the first time the piece is grouped. Survives combat scatter so split-off pieces remember who they belong with and can regroup. */
  squadId?: string;
  /** Tick (exclusive) until which this piece may not plan a new move — set on a capturer that just killed a defended piece, so the defender can retaliate. */
  lockedUntilTick?: number;
  /** Total enemy pieces this one has captured (M5 leveling stat). */
  kills?: number;
  /** Total Currency generated for the owner — sum of captured-piece values
   *  plus any future Resource-square income (M5 leveling stat). */
  profit?: number;
}

export interface Player {
  id: PlayerId;
  name: string;
  /** Hex color used to tint the player's pieces in the UI. */
  color: string;
  currency: number;
}

export interface WorldSnapshot {
  tick: number;
  players: Player[];
  pieces: Piece[];
  /** Resource squares the player should see this tick: all visible
   *  squares within their viewport plus any hidden squares they have
   *  personally discovered. Sent as a sparse list because the board is
   *  infinite — clients never enumerate cells themselves. */
  resources: ResourceSquare[];
  /** Live bombs in the player's viewport (telegraphing detonation). */
  bombs: Bomb[];
  /** Active holes (impassable squares) in the player's viewport. */
  holes: Hole[];
}

export type ResourceKind = 'visible' | 'hidden';

export interface ResourceSquare {
  pos: Coord;
  kind: ResourceKind;
  /** Max Currency/s this square produces while occupied (integer 1..5). */
  yield: number;
  /** Owner of the piece currently standing on the square; absent means
   *  nobody is harvesting it right now. */
  claimedBy?: PlayerId;
}

/** A live bomb sitting on the board. At `fuseEndTick` it detonates and
 *  turns its 3x3 footprint into Holes (and kills any piece inside). */
export interface Bomb {
  id: string;
  ownerId: PlayerId;
  pos: Coord;
  fuseEndTick: number;
}

/** A blasted square. Pieces cannot enter, slide through, or interact
 *  with it. At `regenEndTick` the board heals and the Hole is removed. */
export interface Hole {
  pos: Coord;
  regenEndTick: number;
}
