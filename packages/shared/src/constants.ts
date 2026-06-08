// Tick rate and timing
export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;

// Rendering (client default, overridable)
export const TILE_PX = 48;
/** Minimum and maximum tile size in pixels for the client zoom range.
 *  Min keeps the board readable when zoomed out; max prevents pieces from
 *  filling the entire viewport at extreme zoom in. */
export const ZOOM_MIN_TILE_PX = 16;
export const ZOOM_MAX_TILE_PX = 96;
/** Multiplicative zoom factor per wheel notch. ~1.1 feels natural. */
export const ZOOM_STEP = 1.1;

// World / spawn
export const SPAWN_BASE_RADIUS = 8;
export const SPAWN_RADIUS_PER_PLAYER = 1;
export const SPAWN_MAX_ATTEMPTS = 64;
/** Minimum Chebyshev distance enforced between any newly-spawned pawn and
 *  every existing pawn on the board. Keeps two fresh formations from
 *  landing in immediate combat range of each other on connect. */
export const MIN_PAWN_SEPARATION = 5;

// Pathfinding (server). A* bounded so a runaway goal can't stall the tick.
export const PATHFIND_MAX_DEPTH = 6;
export const PATHFIND_MAX_NODES = 8000;
/** Extra steps over the heuristic minimum that A* is allowed to spend on detours. */
export const PATHFIND_DETOUR_BUDGET = 60;

// Loop protection: cancel a piece's goal once it has repeated the same 2-cycle
// (A -> B -> A -> B ...) this many times. 10 history entries = 5 round-trips.
export const OSCILLATION_HISTORY = 10;

// Combat resolution
/** When two pieces step into each other this tick, the loser freezes this many ticks. */
export const INTIMIDATION_FREEZE_TICKS = 20;

// Formations
/** Piece types that may participate in a shared-direction formation march. */
export const FORMATION_ELIGIBLE_TYPES = ['pawn', 'king', 'queen', 'rook'] as const;
/** Max ticks-of-progress a member may run ahead of the slowest formation member before it waits. */
export const FORMATION_STAGGER_MAX = 2;
/** Chebyshev radius around a king inside which any enemy is considered a threat,
 *  triggering the king-safety retreat behavior. Tuned to cover one-telegraph
 *  reach for adjacent enemies plus a small buffer for queens/rooks closing in. */
export const KING_THREAT_RADIUS = 4;
/** Chebyshev radius within which a solo squadmate is considered "regroupable" —
 *  scattered post-combat pieces look for the nearest living squadmate inside
 *  this radius and walk back toward them. Beyond this, they hold position. */
export const REGROUP_RADIUS = 8;
/** Chebyshev radius from an engagement landing square within which at least one
 *  same-squad piece must exist for an equal-or-worse-value trade to be allowed.
 *  Keeps pieces from sprinting deep into enemy territory alone — they engage
 *  only when a squadmate is close enough to retaliate if the attacker dies.
 *  Free takes (landing undefended) bypass this gate. */
export const ENGAGEMENT_SUPPORT_RADIUS = 2;

// Auto-recapture
/** Extra ticks of capturer-lock beyond the chosen defender's telegraph. */
export const RECAPTURE_LOCK_BUFFER_TICKS = 2;

// Viewport streaming
/** Extra rows/columns of pieces sent beyond what the client claims to see. */
export const VIEWPORT_PADDING = 8;

// Piece base values (Currency)
export const PIECE_VALUE = {
  pawn: 100,
  knight: 200,
  bishop: 250,
  rook: 350,
  queen: 500,
  king: 500,
} as const;

/** Piece types the player can buy from the shop. Kings are excluded — you
 *  start with one and cannot have more. Buy cost equals PIECE_VALUE. */
export const BUYABLE_TYPES = ['pawn', 'knight', 'bishop', 'rook', 'queen'] as const;

// L1 telegraph durations (ms). The cost of a single move scales with how
// many squares the piece actually traverses: every move has a flat base
// (a 1-square step is universal across piece types) and each *additional*
// square traveled adds a per-piece increment. Squares = chebyshev(from,to),
// so a knight's L-jump counts as 2 squares (1 extra), an 8-square queen
// slide counts as 8 (7 extra). Single-square moves are intentionally cheap
// across the board — sliders pay for their range, not for moving at all.
export const TELEGRAPH_BASE_MS = 1000;
export const TELEGRAPH_PER_EXTRA_SQUARE_MS = {
  pawn: 0,    // pawns only ever move 1 square; entry exists for completeness
  king: 0,    // same — king is a 1-square stepper
  knight: 500,
  bishop: 300,
  rook: 350,
  queen: 400,
} as const;

// Leveling (M5)
/** L1 slider max range. L2 extends this. */
export const SLIDER_MAX_RANGE_L1 = 8;
/** L2 slider max range (bishop/rook/queen). */
export const SLIDER_MAX_RANGE_L2 = 16;
/** Pawn L2 maximum forward-move range (capture range stays at 1). */
export const PAWN_MOVE_RANGE_L2 = 2;
/** Additional telegraph ms per square beyond SLIDER_MAX_RANGE_L1 for L2+
 *  slider moves (per spec: +0.1s per extra square beyond 8). */
export const TELEGRAPH_PER_EXTRA_SQUARE_BEYOND_L1_MS = 100;
/** L2 upgrade cost = PIECE_VALUE * this multiplier (per spec: 2x). */
export const UPGRADE_COST_L2_MULT = 2;
/** Piece types eligible for L2 upgrade in M5. Knight (feint) and king
 *  (castling) abilities are scoped for a later milestone — their upgrade
 *  button is shown as "L2 ability pending" until then. */
export const UPGRADE_ELIGIBLE_TYPES_L2 = ['pawn', 'bishop', 'rook', 'queen'] as const;
/** L2 eligibility threshold: a piece becomes eligible to upgrade once it
 *  meets ANY of these (age OR kills OR profit). Tuned for a "playable rate". */
export const LEVEL_UP_THRESHOLDS_L2 = {
  ageTicks: 300,   // 30 seconds at 10 Hz
  kills: 1,
  profit: 100,     // 1 pawn-value of profit
} as const;

// Board theme (tan + dark brown checkerboard)
export const COLOR_LIGHT_TILE = '#e8c98c';
export const COLOR_DARK_TILE = '#5a3a22';

// Selection border colors (per spec)
export const COLOR_HOVER_EMPTY = '#444444';      // dark gray
export const COLOR_CHOSEN_EMPTY = '#bbbbbb';     // light gray
export const COLOR_HOVER_SELECTED = '#1f3a8a';   // dark blue
export const COLOR_CHOSEN_SELECTED = '#14532d';  // dark green
export const COLOR_INVALID = '#7f1d1d';          // dark red

// Resource squares (M6)
/** 1 in N chance for a Visible Resource square (spec: 1/115). */
export const RESOURCE_VISIBLE_DENOM = 115;
/** 1 in N chance for a Hidden Resource square, evaluated only on
 *  cells that did NOT roll a Visible (spec: 1/64). */
export const RESOURCE_HIDDEN_DENOM = 64;
/** Min Currency/s a resource square produces. */
export const RESOURCE_YIELD_MIN = 1;
/** Max Currency/s a resource square produces. */
export const RESOURCE_YIELD_MAX = 5;
/** Fixed seed for resource generation. Changing this remaps every
 *  resource square on the infinite board — only do it pre-launch. */
export const RESOURCE_SEED = 0xC0FFEE;
/** Tile color when a resource square has no piece on it. */
export const COLOR_RESOURCE_IDLE = '#3b0764';   // very dark purple
/** Tile color when a resource square is currently being harvested. */
export const COLOR_RESOURCE_ACTIVE = '#a855f7'; // bright purple-400

// Hazards (M6 — Bombs, Holes, regeneration)
/** Currency cost to place a single bomb. */
export const BOMB_COST = 2500;
/** Telegraph time before a placed bomb detonates. */
export const BOMB_FUSE_MS = 5000;
/** Chebyshev radius around the bomb that becomes Holes. 1 = 3x3 grid. */
export const BOMB_BLAST_RADIUS = 1;
/** Bomb may only be placed within this Chebyshev radius of a friendly piece. */
export const BOMB_PLACEMENT_FRIEND_RADIUS = 5;
/** Bomb may NOT be placed within this Chebyshev radius of an enemy piece. */
export const BOMB_PLACEMENT_ENEMY_RADIUS = 5;
/** How long a Hole persists before the board self-heals back to a normal tile. */
export const HOLE_REGEN_MS = 5 * 60 * 1000; // 5 minutes
/** Fill color for the live bomb tile (amber). */
export const COLOR_BOMB = '#f59e0b';
/** Fill color for a Hole tile (pitch black). */
export const COLOR_HOLE = '#000000';
