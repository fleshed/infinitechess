import { FORMATION_ELIGIBLE_TYPES, FORMATION_STAGGER_MAX, INTIMIDATION_FREEZE_TICKS, KING_THREAT_RADIUS, OSCILLATION_HISTORY, PIECE_VALUE, BUYABLE_TYPES, BOMB_BLAST_RADIUS, BOMB_COST, BOMB_FUSE_MS, BOMB_PLACEMENT_ENEMY_RADIUS, BOMB_PLACEMENT_FRIEND_RADIUS, HOLE_REGEN_MS, RECAPTURE_LOCK_BUFFER_TICKS, REGROUP_RADIUS, ENGAGEMENT_SUPPORT_RADIUS, SPAWN_BASE_RADIUS, SPAWN_MAX_ATTEMPTS, SPAWN_RADIUS_PER_PLAYER, MIN_PAWN_SEPARATION, SLIDER_MAX_RANGE_L1, SLIDER_MAX_RANGE_L2, TELEGRAPH_BASE_MS, TELEGRAPH_PER_EXTRA_SQUARE_BEYOND_L1_MS, TELEGRAPH_PER_EXTRA_SQUARE_MS, TICK_MS, UPGRADE_COST_L2_MULT, UPGRADE_ELIGIBLE_TYPES_L2, LEVEL_UP_THRESHOLDS_L2, VIEWPORT_PADDING, bishopCanReach, canReachForCapture, canMoveTo, chebyshev, coordEq, distanceFor, enumerateMoves, resourceKindAt, resourceYieldAt, } from '@infinitechess/shared';
import { randomUUID } from 'node:crypto';
import { pathfindNextMove, isGoalReachable } from './pathfind.js';
const DEBUG = process.env.DEBUG_PATHFIND !== '0';
// Safety-check holds fire every tick a piece is blocked from stepping;
// noisy under heavy combat. Off by default — set DEBUG_SAFETY=1 to enable.
const DEBUG_SAFETY = process.env.DEBUG_SAFETY === '1';
/** Distance-scaled telegraph duration for a single move. Squares traveled
 *  = chebyshev(from, to). A 1-square step is always TELEGRAPH_BASE_MS; each
 *  additional square adds TELEGRAPH_PER_EXTRA_SQUARE_MS[type]. Knight L-jumps
 *  are chebyshev=2 (one extra). L2+ sliders pay an additional
 *  TELEGRAPH_PER_EXTRA_SQUARE_BEYOND_L1_MS per square beyond SLIDER_MAX_RANGE_L1
 *  (spec: +0.1s/square beyond 8). */
function telegraphMsFor(type, level, from, to) {
    const squares = chebyshev(from, to);
    const extras = Math.max(0, squares - 1);
    let ms = TELEGRAPH_BASE_MS + extras * TELEGRAPH_PER_EXTRA_SQUARE_MS[type];
    if (level >= 2 && squares > SLIDER_MAX_RANGE_L1) {
        ms += (squares - SLIDER_MAX_RANGE_L1) * TELEGRAPH_PER_EXTRA_SQUARE_BEYOND_L1_MS;
    }
    return ms;
}
// Color-wheel palette, walked in hierarchy order so each new player gets the
// most distinct hue still available. Primary first (red, blue, yellow) so a
// 2-player match always reads as Red vs Blue, then secondaries (orange,
// green, purple), then tertiaries (the six in-between hues). Past 12 players
// we wrap and reuse — acceptable, the wheel is exhausted by then.
const PLAYER_COLORS = [
    // primary
    '#dc2626', // red
    '#2563eb', // blue
    '#eab308', // yellow
    // secondary
    '#ea580c', // orange
    '#16a34a', // green
    '#9333ea', // purple
    // tertiary
    '#f43f5e', // vermilion (red-orange)
    '#f59e0b', // amber (yellow-orange)
    '#84cc16', // chartreuse (yellow-green)
    '#0d9488', // teal (blue-green)
    '#6366f1', // indigo (blue-violet)
    '#db2777', // magenta (red-violet)
];
export class World {
    tick = 0;
    players = new Map();
    pieces = new Map();
    /** Per-piece recent landing-square history, used to detect 2-cycles. Server-only. */
    pieceHistory = new Map();
    /** Per-player viewport (world-square coords). Pieces outside are not streamed. */
    viewports = new Map();
    /** Per-player set of Hidden Resource squares the player has discovered
     *  (encoded as "x,y"). Once discovered, hidden squares remain visible
     *  to that player forever (until disconnect). */
    discoveredHidden = new Map();
    // --- spatial indices ---
    //
    // Both maps are maintained incrementally at every mutation site
    // (spawnPiece / removePieceById / commitMove / captureTo). They
    // collapse O(N) board-state queries into O(1) lookups, which is
    // the difference between linear and quadratic per-tick cost when
    // many players are active.
    /** "x,y" -> id of the piece currently sitting on that square. Telegraphed
     *  destinations are NOT in this index — callers needing landing-square
     *  reservations must consult movingIds separately. */
    posIndex = new Map();
    /** Ids of pieces with an in-flight telegraph. Rebuilt at the top of
     *  every step() and patched inline at the small set of inter-tick
     *  sites (tryQueueNextMove, requestMove path) so getOccupant can
     *  consult landings without scanning all pieces. */
    movingIds = new Set();
    /** Per-tick memoization of enemyCanCapture's expensive scan. The
     *  value is the list of enemy piece ids whose imminent position can
     *  capture `square` from the perspective of `allyOwner`; callers pass
     *  an optional `ignoreId` which we filter at read time so cache hits
     *  serve every ignoreId variant. Cleared at the start of step(). */
    enemyCapCache = new Map();
    /** Spatial bucket grid keyed by floor(pos / CELL_SIZE). Lets
     *  enemyCanCapture and snapshotFor scan only pieces in the cells
     *  near a query square, instead of iterating every piece. Maintained
     *  incrementally at the same four pos-mutation sites as posIndex. */
    static CELL_SHIFT = 3; // cell size = 8 squares
    cellIndex = new Map();
    /** Per-owner piece-id index. Lets recomputeFormations and snapshotFor
     *  iterate just one player's army instead of the whole world. */
    piecesByOwner = new Map();
    /** Active bombs awaiting detonation. Key = bomb id. Bombs occupy a
     *  square but do NOT block movement; pieces standing/passing through
     *  a bomb are simply caught in the blast at fuseEndTick. */
    bombs = new Map();
    /** Active holes by "x,y" pos key. Holes are impassable terrain;
     *  getOccupant returns 'blocked' for any square containing one. */
    holes = new Map();
    posKey(x, y) {
        return `${x},${y}`;
    }
    cellKey(x, y) {
        return `${x >> World.CELL_SHIFT},${y >> World.CELL_SHIFT}`;
    }
    addToCell(piece) {
        const k = this.cellKey(piece.pos.x, piece.pos.y);
        let set = this.cellIndex.get(k);
        if (!set) {
            set = new Set();
            this.cellIndex.set(k, set);
        }
        set.add(piece.id);
    }
    removeFromCell(piece) {
        const k = this.cellKey(piece.pos.x, piece.pos.y);
        const set = this.cellIndex.get(k);
        if (!set)
            return;
        set.delete(piece.id);
        if (set.size === 0)
            this.cellIndex.delete(k);
    }
    addPlayer(name) {
        const id = randomUUID();
        // Pick the first palette color no active player is currently using.
        // Indexing by `players.size` would collide when a player leaves and
        // another joins (size decremented, then reused index). We only wrap
        // around the palette once every hue is in use.
        const inUse = new Set();
        for (const p of this.players.values())
            inUse.add(p.color);
        let color = PLAYER_COLORS.find((c) => !inUse.has(c));
        if (!color)
            color = PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
        const player = { id, name: name || `Player-${id.slice(0, 4)}`, color, currency: 0 };
        this.players.set(id, player);
        const center = this.findSpawnCenter();
        this.spawnPiece(id, 'king', center);
        this.spawnPiece(id, 'pawn', { x: center.x, y: center.y + 1 });
        this.spawnPiece(id, 'pawn', { x: center.x, y: center.y - 1 });
        this.spawnPiece(id, 'pawn', { x: center.x + 1, y: center.y });
        this.spawnPiece(id, 'pawn', { x: center.x - 1, y: center.y });
        return player;
    }
    removePlayer(playerId) {
        this.players.delete(playerId);
        this.viewports.delete(playerId);
        this.discoveredHidden.delete(playerId);
        for (const [pid, piece] of [...this.pieces]) {
            if (piece.ownerId === playerId)
                this.removePieceById(pid);
        }
    }
    setViewport(playerId, vp) {
        // Sanity clamp so a buggy/malicious client can't request all-pieces by sending a huge box.
        const span = 200;
        const w = Math.min(span, Math.max(0, vp.maxX - vp.minX));
        const h = Math.min(span, Math.max(0, vp.maxY - vp.minY));
        this.viewports.set(playerId, {
            minX: vp.minX,
            minY: vp.minY,
            maxX: vp.minX + w,
            maxY: vp.minY + h,
        });
    }
    /** Player intent: move this piece toward this square. */
    requestMove(playerId, pieceId, goal, 
    /** When true, set the goal but don't snappy-queue the first step — used by
     *  formationMove so every member's formationId is set before any of them
     *  plan, otherwise the planner picks an off-formation path. */
    deferQueue = false, 
    /** Friendly piece ids to treat as empty squares during the up-front
     *  reachability + friendly-target checks. Used by formationMove so back
     *  members aren't rejected for "colliding" with teammates that are
     *  vacating in the same group move. */
    ignoreFriendlyIds) {
        const piece = this.pieces.get(pieceId);
        if (!piece)
            return { code: 'no_such_piece', message: 'Piece not found' };
        if (piece.ownerId !== playerId) {
            return { code: 'not_owner', message: 'You do not own this piece' };
        }
        if (coordEq(piece.pos, goal)) {
            piece.goal = undefined;
            return null;
        }
        const target = this.getPieceAt(goal);
        if (target && target.ownerId === playerId && !(ignoreFriendlyIds && ignoreFriendlyIds.has(target.id))) {
            return { code: 'friendly_target', message: 'Cannot target your own piece' };
        }
        if (piece.type === 'king' && target && target.type === 'king') {
            return { code: 'king_vs_king', message: 'Kings cannot capture each other' };
        }
        if (piece.type === 'bishop' && !bishopCanReach(piece.pos, goal)) {
            return { code: 'unreachable', message: 'Bishop cannot reach a square of the opposite color' };
        }
        // Up-front reachability check: refuse goals the piece can provably never
        // reach under the current board state. Stops oscillation before it begins.
        const occLookup = ignoreFriendlyIds && ignoreFriendlyIds.size > 0
            ? (c) => {
                const occ = this.getPieceAt(c);
                if (occ && ignoreFriendlyIds.has(occ.id))
                    return 'empty';
                return this.getOccupant(c, piece.ownerId);
            }
            : (c) => this.getOccupant(c, piece.ownerId);
        if (!isGoalReachable(piece, goal, occLookup)) {
            if (DEBUG)
                console.log(`[req] REJECT ${piece.type} ${piece.id.slice(0, 4)} -> (${goal.x},${goal.y}) unreachable`);
            return { code: 'unreachable', message: 'No path to that square right now' };
        }
        if (DEBUG)
            console.log(`[req] accept ${piece.type} ${piece.id.slice(0, 4)} (${piece.pos.x},${piece.pos.y}) -> (${goal.x},${goal.y}) fid=${piece.formationId ? piece.formationId.slice(0, 4) : 'none'}`);
        // A fresh player-issued goal starts a new pursuit; stale landing-history
        // from prior goals (or prior formation marches) must not poison the
        // any-length cycle check, or the piece will spuriously cancel on its
        // first re-entry into an old square.
        if (!piece.goal || !coordEq(piece.goal, goal))
            this.pieceHistory.delete(pieceId);
        piece.goal = goal;
        // Single-piece ctrl-click moves auto-leave when the target is
        // non-adjacent to every relative — otherwise the recompute would
        // re-union the piece each tick and regroupScan would pull it back
        // as soon as it arrived, defeating the move. deferQueue distinguishes
        // a formation march (which preserves membership) from a player
        // single-piece order. Two cases:
        //  (a) Piece is in a formation: stamp formationLeft on current peers
        //      so recomputeFormations cannot re-union them, and clear slot/
        //      squad memory so regroupScan can't reconvene either.
        //  (b) Piece is solo but carries a stale squadId from a prior
        //      formation: the legacy regroupScan branch will walk it back
        //      toward old squadmates within REGROUP_RADIUS the moment it
        //      goes idle. Clearing squadId/slot severs that gravity. The
        //      piece can re-form a fresh squad later via recomputeFormations.
        if (!deferQueue) {
            if (piece.formationId) {
                const peers = [];
                let anyAdjacentToGoal = false;
                for (const peer of this.pieces.values()) {
                    if (peer.id === piece.id)
                        continue;
                    if (peer.formationId !== piece.formationId)
                        continue;
                    peers.push(peer.id);
                    if (chebyshev(peer.pos, goal) <= 1)
                        anyAdjacentToGoal = true;
                }
                if (!anyAdjacentToGoal && peers.length > 0) {
                    piece.formationLeft = [...new Set([...(piece.formationLeft ?? []), ...peers])];
                    piece.squadId = undefined;
                    piece.slotOffset = undefined;
                    piece.formationSlotId = undefined;
                    if (DEBUG)
                        console.log(`[leave] ${piece.type} ${piece.id.slice(0, 4)} auto-leaves fid=${piece.formationId.slice(0, 4)} (target non-adjacent)`);
                }
            }
            else if (piece.squadId) {
                let anyAdjacentToGoal = false;
                let hasSquadmate = false;
                for (const peer of this.pieces.values()) {
                    if (peer.id === piece.id)
                        continue;
                    if (peer.ownerId !== piece.ownerId)
                        continue;
                    if (peer.squadId !== piece.squadId)
                        continue;
                    hasSquadmate = true;
                    if (chebyshev(peer.pos, goal) <= 1) {
                        anyAdjacentToGoal = true;
                        break;
                    }
                }
                if (hasSquadmate && !anyAdjacentToGoal) {
                    piece.squadId = undefined;
                    piece.slotOffset = undefined;
                    piece.formationSlotId = undefined;
                    if (DEBUG)
                        console.log(`[detach] ${piece.type} ${piece.id.slice(0, 4)} severs squad memory (target non-adjacent to squadmates)`);
                }
            }
        }
        // Snappy feedback: try to queue the first step right away if the piece is idle and not frozen.
        if (!deferQueue && !piece.move && !(piece.frozenUntilTick && piece.frozenUntilTick > this.tick)) {
            this.tryQueueNextMove(piece);
        }
        return null;
    }
    /**
     * Player intent: march a group of pieces in formation toward `target`. The
     * piece closest to `target` (Chebyshev) becomes the anchor; every other
     * eligible member gets `target + (pos - anchor)` as its individual goal and
     * all members share a `formationId` so the planner can stagger them.
     *
     * Non-eligible pieces (bishop, knight) silently get the same offset goal but
     * no formation tag — they move independently.
     */
    formationMove(playerId, pieceIds, target) {
        const pieces = [];
        for (const id of pieceIds) {
            const p = this.pieces.get(id);
            if (p && p.ownerId === playerId)
                pieces.push(p);
        }
        if (DEBUG) {
            const detail = pieces
                .map((p) => `${p.type} ${p.id.slice(0, 4)}@(${p.pos.x},${p.pos.y}) fid=${p.formationId ? p.formationId.slice(0, 4) : 'none'}`)
                .join('; ');
            console.log(`[formationMove] player ${playerId.slice(0, 4)} target=(${target.x},${target.y}) count=${pieces.length}/${pieceIds.length} [${detail}]`);
        }
        if (pieces.length === 0)
            return;
        // Anchor = the selected piece closest to the click (Chebyshev).
        let anchor = pieces[0];
        let bestD = Infinity;
        for (const p of pieces) {
            const d = chebyshev(p.pos, target);
            if (d < bestD) {
                bestD = d;
                anchor = p;
            }
        }
        // Squad memory for knights/bishops included in the selection. The
        // auto-formation union-find only runs over FORMATION_ELIGIBLE_TYPES,
        // so knights/bishops never get a squadId organically. Without one
        // they can't regroup, get follow-targeted by king-safety, or qualify
        // for the new line-of-sight recapture in chooseRecaptureDefender.
        // Stamp them with the anchor's squad (or the anchor's own id when
        // the anchor itself has never formed a squad) so they ride along
        // with the group from here on. `??=` preserves any prior memory.
        const squadStamp = anchor.squadId ?? anchor.id;
        for (const p of pieces) {
            if (p.type === 'knight' || p.type === 'bishop')
                p.squadId ??= squadStamp;
        }
        // Defer the initial queue so every member's goal is set before any of
        // them plan; next step()'s cascade will plan everyone with full board
        // context and correct formationId (auto-computed at top of step).
        const memberIds = new Set(pieces.map((p) => p.id));
        // Prefer slot-relative offsets when every selected piece shares the same
        // (valid) formation slot frame — that preserves the original at-rest
        // shape even if the formation is currently mid-march and visibly
        // staggered. Fall back per-piece to raw pos diff for any member missing
        // slot data (e.g., just spawned, never been in a formation, or in a
        // different formation than the anchor).
        const anchorSlotValid = anchor.slotOffset !== undefined &&
            anchor.formationSlotId !== undefined &&
            anchor.formationSlotId === anchor.formationId;
        for (const p of pieces) {
            let offX;
            let offY;
            const slotMatch = anchorSlotValid &&
                p.slotOffset !== undefined &&
                p.formationSlotId !== undefined &&
                p.formationSlotId === anchor.formationSlotId;
            if (slotMatch) {
                offX = p.slotOffset.x - anchor.slotOffset.x;
                offY = p.slotOffset.y - anchor.slotOffset.y;
            }
            else {
                offX = p.pos.x - anchor.pos.x;
                offY = p.pos.y - anchor.pos.y;
            }
            const goal = { x: target.x + offX, y: target.y + offY };
            this.requestMove(playerId, p.id, goal, true, memberIds);
            // Mark this goal as a coordinated formation march. requestMove also
            // sets p.goal; we stamp formationGoal as a value-copy so any later
            // goal reassignment (engagement, regroup, recapture, king-safety)
            // automatically invalidates the march marker by mismatch.
            if (p.goal && coordEq(p.goal, goal))
                p.formationGoal = { ...goal };
        }
    }
    /** Drop the goal on this piece. */
    cancelGoal(playerId, pieceId) {
        const p = this.pieces.get(pieceId);
        if (!p || p.ownerId !== playerId)
            return;
        p.goal = undefined;
    }
    /**
     * Explicitly break this piece's current auto-formation. We freeze the
     * current peer set into `formationLeft` so `recomputeFormations` will
     * not re-union this piece with any of them WHILE they remain chebyshev-
     * adjacent. Once a peer wanders out of range its id auto-prunes from
     * the list (see `recomputeFormations`) and the piece can naturally
     * re-form a fresh formation with anyone in reach again.
     *
     * No-op when the piece isn't in a formation right now — nothing to leave.
     */
    leaveFormation(playerId, pieceId) {
        const p = this.pieces.get(pieceId);
        if (!p)
            return { code: 'no_such_piece', message: 'Piece not found' };
        if (p.ownerId !== playerId)
            return { code: 'not_owner', message: 'You do not own this piece' };
        if (!p.formationId)
            return null;
        const peers = [];
        for (const peer of this.pieces.values()) {
            if (peer.id === p.id)
                continue;
            if (peer.formationId !== p.formationId)
                continue;
            peers.push(peer.id);
        }
        if (peers.length === 0)
            return null;
        p.formationLeft = [...new Set([...(p.formationLeft ?? []), ...peers])];
        p.formationId = undefined;
        // Sever slot + squad memory (see auto-leave in requestMove for the
        // same reasoning) — without this regroupScan will rally the piece
        // back onto its old slot anchor as soon as it goes idle.
        p.squadId = undefined;
        p.slotOffset = undefined;
        p.formationSlotId = undefined;
        if (DEBUG)
            console.log(`[leave] ${p.type} ${p.id.slice(0, 4)} explicit leave, excludes [${peers.map((id) => id.slice(0, 4)).join(',')}]`);
        return null;
    }
    /** Sell a piece for its full PIECE_VALUE. Kings cannot be sold. */
    sellPiece(playerId, pieceId) {
        const p = this.pieces.get(pieceId);
        if (!p)
            return { code: 'no_such_piece', message: 'Piece not found' };
        if (p.ownerId !== playerId)
            return { code: 'not_owner', message: 'You do not own this piece' };
        if (p.type === 'king')
            return { code: 'cannot_sell_king', message: 'Cannot sell your king' };
        const owner = this.players.get(playerId);
        if (owner)
            owner.currency += PIECE_VALUE[p.type];
        this.removePieceById(p.id);
        return null;
    }
    /**
     * Buy and spawn a new piece for `playerId` at `pos`, debiting PIECE_VALUE
     * from currency on success. Rules:
     *   - `type` must be in BUYABLE_TYPES (kings are excluded).
     *   - Player must have at least PIECE_VALUE[type] currency.
     *   - `pos` must be empty AND not reserved by any telegraph (friendly or enemy).
     *   - `pos` must be Chebyshev-adjacent to at least one of the player's
     *     existing pieces — pieces only spawn from your own line, never deep
     *     in enemy territory or in unrelated open ground.
     */
    buyPiece(playerId, type, pos) {
        const player = this.players.get(playerId);
        if (!player)
            return { code: 'no_such_player', message: 'Player not found' };
        if (!BUYABLE_TYPES.includes(type)) {
            return { code: 'not_buyable', message: `${type} cannot be purchased` };
        }
        const cost = PIECE_VALUE[type];
        if (player.currency < cost) {
            return { code: 'insufficient_funds', message: `Need ${cost}, have ${player.currency}` };
        }
        if (this.getPieceAt(pos)) {
            return { code: 'occupied', message: 'Square is occupied' };
        }
        if (this.holes.has(this.posKey(pos.x, pos.y))) {
            return { code: 'blocked_terrain', message: 'Square is a hole' };
        }
        if (this.bombs.has(this.bombKeyAt(pos))) {
            return { code: 'occupied', message: 'Square has a live bomb on it' };
        }
        // Any in-flight telegraph landing on `pos` reserves it.
        for (const p of this.pieces.values()) {
            if (p.move && coordEq(p.move.to, pos)) {
                return { code: 'occupied', message: 'Square is targeted by an in-flight move' };
            }
        }
        // Adjacency requirement: at least one of the player's pieces is within
        // Chebyshev distance 1 of the spawn square.
        let adjacent = false;
        for (const p of this.pieces.values()) {
            if (p.ownerId !== playerId)
                continue;
            if (chebyshev(p.pos, pos) <= 1) {
                adjacent = true;
                break;
            }
        }
        if (!adjacent) {
            return { code: 'not_adjacent', message: 'Must spawn adjacent to one of your pieces' };
        }
        // Reject placements that would immediately threaten an enemy king.
        // `enumerateMoves` from `pos` with the new piece's type/level returns
        // every square it could move-or-capture onto next tick (including
        // through clear slide lanes for sliders); if any enemy king sits on
        // one of those squares, the placement would auto-check that king and
        // is disallowed.
        const occFn = (c) => this.getOccupant(c, playerId);
        const reach = enumerateMoves(type, 1, pos, occFn);
        for (const enemy of this.pieces.values()) {
            if (enemy.ownerId === playerId || enemy.type !== 'king')
                continue;
            if (reach.some((c) => coordEq(c, enemy.pos))) {
                return {
                    code: 'would_check_king',
                    message: 'Placement would put an enemy king in check',
                };
            }
        }
        player.currency -= cost;
        this.spawnPiece(playerId, type, pos);
        return null;
    }
    /** L2 upgrade cost for a given piece type (spec: 2x base value). */
    static upgradeCostL2(type) {
        return PIECE_VALUE[type] * UPGRADE_COST_L2_MULT;
    }
    /** True iff the type is currently allowed to upgrade to L2 in M5. */
    static canUpgradeTypeL2(type) {
        return UPGRADE_ELIGIBLE_TYPES_L2.includes(type);
    }
    /** True iff `piece` has met ANY of the L2 stat thresholds (age, kills,
     *  profit). Currency is checked separately in `upgradePiece`. */
    isEligibleForUpgradeL2(piece) {
        if (piece.level >= 2)
            return false;
        if (!World.canUpgradeTypeL2(piece.type))
            return false;
        const age = this.tick - piece.bornTick;
        return (age >= LEVEL_UP_THRESHOLDS_L2.ageTicks ||
            (piece.kills ?? 0) >= LEVEL_UP_THRESHOLDS_L2.kills ||
            (piece.profit ?? 0) >= LEVEL_UP_THRESHOLDS_L2.profit);
    }
    /**
     * Spend currency to upgrade `pieceId` (owned by `playerId`) from L1 to L2.
     * Rules:
     *   - Caller must own the piece.
     *   - Piece must currently be L1.
     *   - Piece type must be in UPGRADE_ELIGIBLE_TYPES_L2.
     *   - Piece must meet at least one stat threshold (age/kills/profit).
     *   - Player must have at least the upgrade cost in currency.
     * On success: deducts currency and sets `piece.level = 2`. The new ruleset
     * (range, telegraph penalty, etc.) is picked up on the next tick.
     */
    upgradePiece(playerId, pieceId) {
        const player = this.players.get(playerId);
        if (!player)
            return { code: 'no_such_player', message: 'Player not found' };
        const piece = this.pieces.get(pieceId);
        if (!piece)
            return { code: 'no_such_piece', message: 'Piece not found' };
        if (piece.ownerId !== playerId) {
            return { code: 'not_owner', message: 'You do not own this piece' };
        }
        if (piece.level >= 2) {
            return { code: 'already_upgraded', message: 'Piece is already L2 or higher' };
        }
        if (!World.canUpgradeTypeL2(piece.type)) {
            return { code: 'type_locked', message: `${piece.type} L2 ability not yet implemented` };
        }
        if (!this.isEligibleForUpgradeL2(piece)) {
            return { code: 'not_eligible', message: 'Piece has not met any L2 stat threshold yet' };
        }
        const cost = World.upgradeCostL2(piece.type);
        if (player.currency < cost) {
            return {
                code: 'insufficient_funds',
                message: `Need ${cost}, have ${player.currency}`,
            };
        }
        player.currency -= cost;
        piece.level = 2;
        if (DEBUG) {
            console.log(`[upgrade-L2] ${piece.type} ${piece.id.slice(0, 4)} owner ${playerId.slice(0, 4)} cost=${cost}`);
        }
        return null;
    }
    /** Position key used to look up at-most-one bomb per square. The map
     *  uses the same `${x},${y}` shape as `posKey` so we can share helpers. */
    bombKeyAt(pos) {
        return this.posKey(pos.x, pos.y);
    }
    /**
     * Place a bomb at `pos` for `playerId`. Validation mirrors `buyPiece`:
     *   - Player must exist and have at least BOMB_COST currency.
     *   - Square must be empty (no piece, no other bomb, no hole).
     *   - Within Chebyshev BOMB_PLACEMENT_FRIEND_RADIUS of one of the player's own pieces.
     *   - No enemy piece within Chebyshev BOMB_PLACEMENT_ENEMY_RADIUS — bombs are
     *     a defensive/area-denial tool, not a tactical strike.
     * On success: debits cost, inserts a Bomb with fuseEndTick = tick + BOMB_FUSE_MS/TICK_MS.
     */
    placeBomb(playerId, pos) {
        const player = this.players.get(playerId);
        if (!player)
            return { code: 'no_such_player', message: 'Player not found' };
        if (player.currency < BOMB_COST) {
            return { code: 'insufficient_funds', message: `Need ${BOMB_COST}, have ${player.currency}` };
        }
        if (this.getPieceAt(pos)) {
            return { code: 'occupied', message: 'Square is occupied' };
        }
        const key = this.bombKeyAt(pos);
        if (this.bombs.has(key)) {
            return { code: 'occupied', message: 'A bomb is already placed here' };
        }
        if (this.holes.has(key)) {
            return { code: 'blocked_terrain', message: 'Square is a hole' };
        }
        let friendlyClose = false;
        let enemyTooClose = false;
        for (const p of this.pieces.values()) {
            const d = chebyshev(p.pos, pos);
            if (p.ownerId === playerId) {
                if (d <= BOMB_PLACEMENT_FRIEND_RADIUS)
                    friendlyClose = true;
            }
            else {
                if (d < BOMB_PLACEMENT_ENEMY_RADIUS) {
                    enemyTooClose = true;
                    break;
                }
            }
        }
        if (enemyTooClose) {
            return {
                code: 'enemy_too_close',
                message: `Enemy piece within ${BOMB_PLACEMENT_ENEMY_RADIUS} squares`,
            };
        }
        if (!friendlyClose) {
            return {
                code: 'no_friendly_support',
                message: `Must place within ${BOMB_PLACEMENT_FRIEND_RADIUS} squares of one of your pieces`,
            };
        }
        player.currency -= BOMB_COST;
        const id = randomUUID();
        const fuseTicks = Math.max(1, Math.round(BOMB_FUSE_MS / TICK_MS));
        this.bombs.set(id, {
            id,
            ownerId: playerId,
            pos: { ...pos },
            fuseEndTick: this.tick + fuseTicks,
        });
        if (DEBUG) {
            console.log(`[bomb] placed by ${playerId.slice(0, 4)} at (${pos.x},${pos.y}) detonates @t${this.tick + fuseTicks}`);
        }
        return null;
    }
    /**
     * Resolve hazard timers at the start of each tick.
     *  - Bombs whose fuse expired detonate: every square in a Chebyshev
     *    BOMB_BLAST_RADIUS box becomes a Hole, and any piece inside is
     *    removed (environmental kill, no kill-credit attribution).
     *  - Holes whose regenEndTick passed are deleted; the board heals.
     */
    tickHazards() {
        if (this.bombs.size > 0) {
            const holeTicks = Math.max(1, Math.round(HOLE_REGEN_MS / TICK_MS));
            for (const [bombId, bomb] of [...this.bombs]) {
                if (bomb.fuseEndTick > this.tick)
                    continue;
                this.bombs.delete(bombId);
                for (let dx = -BOMB_BLAST_RADIUS; dx <= BOMB_BLAST_RADIUS; dx++) {
                    for (let dy = -BOMB_BLAST_RADIUS; dy <= BOMB_BLAST_RADIUS; dy++) {
                        const cx = bomb.pos.x + dx;
                        const cy = bomb.pos.y + dy;
                        const victimId = this.posIndex.get(this.posKey(cx, cy));
                        if (victimId)
                            this.removePieceById(victimId);
                        const k = this.posKey(cx, cy);
                        this.holes.set(k, {
                            pos: { x: cx, y: cy },
                            regenEndTick: this.tick + holeTicks,
                        });
                    }
                }
                if (DEBUG) {
                    console.log(`[bomb] detonated at (${bomb.pos.x},${bomb.pos.y}) t=${this.tick}`);
                }
            }
        }
        if (this.holes.size > 0) {
            for (const [k, hole] of this.holes) {
                if (hole.regenEndTick <= this.tick)
                    this.holes.delete(k);
            }
        }
    }
    step() {
        this.tick += 1;
        // Per-tick caches: enemy-threat memo is cleared because both telegraph
        // state and piece positions can change tick-to-tick; movingIds is
        // rebuilt because piece.move is mutated at many sites and a single
        // source of truth is simpler than maintaining the set inline.
        this.enemyCapCache.clear();
        this.movingIds.clear();
        for (const p of this.pieces.values())
            if (p.move)
                this.movingIds.add(p.id);
        // Hazards: detonate any ready bombs (destroying pieces in the blast
        // and replacing the 3x3 with Holes) BEFORE planning, then regen any
        // Holes whose timer expired. Order: detonate first so a piece killed
        // by a blast doesn't get a chance to plan a move this tick.
        this.tickHazards();
        // Auto-formations: groups of friendly pieces that can recapture each
        // other (and pawn-sticky K/Q/R neighbors) are computed from current
        // board geometry every tick. Membership is purely derived — a piece
        // leaves the formation the instant it falls out of range.
        this.recomputeFormations();
        // Clear expired freeze / lock once.
        for (const piece of this.pieces.values()) {
            if (piece.frozenUntilTick && piece.frozenUntilTick <= this.tick) {
                piece.frozenUntilTick = undefined;
            }
            if (piece.lockedUntilTick && piece.lockedUntilTick <= this.tick) {
                piece.lockedUntilTick = undefined;
            }
        }
        // 0. King safety. Any in-formation king reacts to incoming enemy
        //    telegraphs and proximity. Runs BEFORE the engagement scan so a
        //    king's safety always wins over an opportunistic lone-piece take.
        //    Lone kings (no formation peers) fall through to the engagement
        //    scan and may capture undefended lone enemies.
        //
        //    Note: we do NOT skip on `piece.move` or `piece.goal` —
        //    kingSafetyScan owns the override decision. On a CRITICAL threat
        //    it aborts any in-flight telegraph and replans toward safety this
        //    same tick (the king’s 10-tick telegraph is enough lead time to
        //    escape if we react the same tick the enemy commits to the kill).
        for (const piece of this.pieces.values()) {
            if (piece.type !== 'king')
                continue;
            if (piece.frozenUntilTick && piece.frozenUntilTick > this.tick)
                continue;
            if (piece.lockedUntilTick && piece.lockedUntilTick > this.tick)
                continue;
            this.kingSafetyScan(piece);
            // If the safety pass left the king idle (no threat, or threat
            // resolved), pull it back to the tail end of its formation so it
            // doesn't strand itself in a safe corner while the rest of the
            // squad pushes on.
            if (!piece.move && !piece.goal)
                this.kingFollowScan(piece);
        }
        // 0b. Engagement scan. Any idle piece (no goal, no active move, not
        //    locked or frozen) looks for a single-move enemy capture it can
        //    safely make and sets that as its goal. The trade evaluator gates
        //    the choice so we don't initiate losing exchanges. Pieces in the
        //    middle of a player-issued march keep their goal UNLESS they're
        //    under immediate enemy threat — then they break formation to
        //    counter-attack (defensive engage). If no favorable counter
        //    exists the goal is restored and the step-safety filter in
        //    `tryQueueNextMove` will hold them in place until the threat
        //    moves on.
        for (const piece of this.pieces.values()) {
            if (piece.move)
                continue;
            if (piece.frozenUntilTick && piece.frozenUntilTick > this.tick)
                continue;
            if (piece.lockedUntilTick && piece.lockedUntilTick > this.tick)
                continue;
            if (piece.goal) {
                if (piece.type === 'king')
                    continue;
                if (!this.enemyCanCapture(piece.pos, piece.ownerId, piece.id))
                    continue;
                const savedGoal = piece.goal;
                const savedFormationGoal = piece.formationGoal;
                piece.goal = undefined;
                const engaged = this.engagementScan(piece);
                if (!engaged) {
                    piece.goal = savedGoal;
                    piece.formationGoal = savedFormationGoal;
                }
                else if (DEBUG) {
                    console.log(`[engage-march] ${piece.type} ${piece.id.slice(0, 4)} broke march at (${piece.pos.x},${piece.pos.y}) under threat`);
                }
                continue;
            }
            this.engagementScan(piece);
        }
        // 0c. Regroup scan. After combat, surviving squadmates often end up
        //    solo (union-find graph fragmented). An idle solo piece with a
        //    `squadId` walks toward its nearest living squadmate inside
        //    REGROUP_RADIUS so the original formation can reconvene. Runs
        //    AFTER engagement so a piece in striking distance of a target
        //    still attacks first; regroup is a fallback for true idleness.
        for (const piece of this.pieces.values()) {
            if (piece.move)
                continue;
            if (piece.goal)
                continue;
            if (piece.formationId)
                continue;
            if (piece.frozenUntilTick && piece.frozenUntilTick > this.tick)
                continue;
            if (piece.lockedUntilTick && piece.lockedUntilTick > this.tick)
                continue;
            this.regroupScan(piece);
        }
        // 1. Plan in cascading passes. When a piece queues a telegraph it frees
        //    its current square (vacating-friendly reads as empty), letting a
        //    follower right behind it plan into that square the same tick. Cap
        //    the passes at MAX_PLAN_PASSES so we never loop on pathological setups.
        const MAX_PLAN_PASSES = 8;
        for (let pass = 0; pass < MAX_PLAN_PASSES; pass++) {
            let queued = 0;
            for (const piece of this.pieces.values()) {
                if (piece.move)
                    continue;
                if (piece.frozenUntilTick && piece.frozenUntilTick > this.tick)
                    continue;
                if (piece.lockedUntilTick && piece.lockedUntilTick > this.tick)
                    continue;
                if (!piece.goal)
                    continue;
                this.tryQueueNextMove(piece);
                if (piece.move)
                    queued++;
            }
            if (queued === 0)
                break;
        }
        // 2. Resolve any mutual-attack pairs whose moves both end this tick.
        this.resolveMutualAttacks();
        // 3. Commit: resolve any move whose endTick has arrived. Process in
        //    dependency order so a follower can take a leader's square the same
        //    tick the leader vacates it. We repeatedly commit pieces whose
        //    destination is empty or held by a friendly that is NOT also
        //    committing this tick; the loop terminates when no progress is made,
        //    then we flush any cycle remainders through the normal path (which
        //    aborts cleanly via the "friendly arrived first" branch).
        const pending = new Set();
        for (const [id, piece] of this.pieces) {
            if (piece.move && this.tick >= piece.move.endTick)
                pending.add(id);
        }
        let progress = true;
        while (progress) {
            progress = false;
            for (const id of [...pending]) {
                const piece = this.pieces.get(id);
                if (!piece || !piece.move) {
                    pending.delete(id);
                    continue;
                }
                const blocker = this.getPieceAt(piece.move.to);
                if (blocker &&
                    blocker !== piece &&
                    blocker.ownerId === piece.ownerId &&
                    pending.has(blocker.id)) {
                    continue;
                }
                this.commitMove(piece);
                pending.delete(id);
                progress = true;
            }
        }
        for (const id of pending) {
            const piece = this.pieces.get(id);
            if (piece && piece.move)
                this.commitMove(piece);
        }
        // 4. Resource income. After all commits this tick, any piece sitting
        //    on a resource square credits its owner a fractional payout
        //    (yield * TICK_MS / 1000). Hidden squares are also added to the
        //    owner's discovered set so they remain visible to that player.
        this.accrueResourceIncome();
    }
    snapshot() {
        return {
            tick: this.tick,
            players: [...this.players.values()],
            pieces: [...this.pieces.values()],
            resources: [],
            bombs: [...this.bombs.values()],
            holes: [...this.holes.values()],
        };
    }
    /** Filtered snapshot for one player: only pieces near their viewport, plus all of their own pieces. */
    snapshotFor(playerId) {
        const vp = this.viewports.get(playerId);
        if (!vp)
            return this.snapshot();
        const minX = vp.minX - VIEWPORT_PADDING;
        const maxX = vp.maxX + VIEWPORT_PADDING;
        const minY = vp.minY - VIEWPORT_PADDING;
        const maxY = vp.maxY + VIEWPORT_PADDING;
        const pieces = [];
        const seen = new Set();
        // Walk cells overlapping the viewport instead of every piece on the
        // world. With 100 players each sending viewport-sized snapshots
        // this is the difference between O(N · clients) and O(viewport·clients).
        const cMinX = minX >> World.CELL_SHIFT;
        const cMaxX = maxX >> World.CELL_SHIFT;
        const cMinY = minY >> World.CELL_SHIFT;
        const cMaxY = maxY >> World.CELL_SHIFT;
        for (let cx = cMinX; cx <= cMaxX; cx++) {
            for (let cy = cMinY; cy <= cMaxY; cy++) {
                const cell = this.cellIndex.get(`${cx},${cy}`);
                if (!cell)
                    continue;
                for (const id of cell) {
                    const p = this.pieces.get(id);
                    if (!p)
                        continue;
                    if (!pieceTouchesRect(p, minX, maxX, minY, maxY))
                        continue;
                    seen.add(id);
                    pieces.push(p);
                }
            }
        }
        // Add any of the player's own pieces NOT already captured by the
        // viewport sweep — spec says you always see your own army.
        const ownPieces = this.piecesByOwner.get(playerId);
        if (ownPieces) {
            for (const id of ownPieces) {
                if (seen.has(id))
                    continue;
                const p = this.pieces.get(id);
                if (p)
                    pieces.push(p);
            }
        }
        // Hazards filtered by the same viewport rect. Both bombs and holes
        // are global state, but the client only needs to render what its
        // camera can see.
        const bombs = [];
        for (const b of this.bombs.values()) {
            if (b.pos.x >= minX && b.pos.x <= maxX && b.pos.y >= minY && b.pos.y <= maxY)
                bombs.push(b);
        }
        const holes = [];
        for (const h of this.holes.values()) {
            if (h.pos.x >= minX && h.pos.x <= maxX && h.pos.y >= minY && h.pos.y <= maxY)
                holes.push(h);
        }
        return {
            tick: this.tick,
            players: [...this.players.values()],
            pieces,
            resources: this.resourcesFor(playerId, minX, maxX, minY, maxY),
            bombs,
            holes,
        };
    }
    /** Walk every piece on the board once per tick; if it stands on a
     *  resource square, credit `yield * TICK_MS / 1000` to its owner and
     *  to the piece's profit stat. Hidden squares are also marked
     *  discovered for the owner so they begin appearing in their snapshots. */
    accrueResourceIncome() {
        const incomePerTick = TICK_MS / 1000; // 0.1 at 10 Hz
        for (const piece of this.pieces.values()) {
            const kind = resourceKindAt(piece.pos.x, piece.pos.y);
            if (!kind)
                continue;
            const owner = this.players.get(piece.ownerId);
            if (!owner)
                continue;
            const credit = resourceYieldAt(piece.pos.x, piece.pos.y) * incomePerTick;
            owner.currency += credit;
            piece.profit = (piece.profit ?? 0) + credit;
            if (kind === 'hidden') {
                let set = this.discoveredHidden.get(owner.id);
                if (!set) {
                    set = new Set();
                    this.discoveredHidden.set(owner.id, set);
                }
                set.add(`${piece.pos.x},${piece.pos.y}`);
            }
        }
    }
    /** Collect every resource square inside the rect that should be visible
     *  to `playerId`: all Visible squares + any Hidden squares the player
     *  has previously discovered (anywhere on the board, not just inside
     *  this rect). Each entry's `claimedBy` reflects current piece
     *  occupancy so the client can swap to the active color. */
    resourcesFor(playerId, minX, maxX, minY, maxY) {
        const out = [];
        const seen = new Set();
        const claimAt = (x, y) => {
            for (const p of this.pieces.values()) {
                if (p.pos.x === x && p.pos.y === y)
                    return p.ownerId;
            }
            return undefined;
        };
        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const kind = resourceKindAt(x, y);
                if (!kind)
                    continue;
                if (kind === 'hidden') {
                    const key = `${x},${y}`;
                    const discovered = this.discoveredHidden.get(playerId);
                    if (!discovered || !discovered.has(key))
                        continue;
                    seen.add(key);
                }
                const claimedBy = claimAt(x, y);
                out.push({
                    pos: { x, y },
                    kind,
                    yield: resourceYieldAt(x, y),
                    ...(claimedBy ? { claimedBy } : {}),
                });
            }
        }
        // Discovered hidden squares OUTSIDE the viewport also remain visible
        // to the discovering player per spec ("remains visible, but only to
        // them"). Add any missing ones so they don't pop out of the HUD when
        // the player pans away.
        const discovered = this.discoveredHidden.get(playerId);
        if (discovered) {
            for (const key of discovered) {
                if (seen.has(key))
                    continue;
                const [sx, sy] = key.split(',');
                const x = Number(sx);
                const y = Number(sy);
                if (x >= minX && x <= maxX && y >= minY && y <= maxY)
                    continue;
                const claimedBy = claimAt(x, y);
                out.push({
                    pos: { x, y },
                    kind: 'hidden',
                    yield: resourceYieldAt(x, y),
                    ...(claimedBy ? { claimedBy } : {}),
                });
            }
        }
        return out;
    }
    // --- internals ---
    commitMove(piece) {
        const move = piece.move;
        // If a hole appeared at the destination since the telegraph was
        // queued (a bomb detonated this tick on the same square), abort the
        // move and let pathfind pick a new step next tick. Piece stays put.
        if (this.holes.has(this.posKey(move.to.x, move.to.y))) {
            piece.move = undefined;
            this.movingIds.delete(piece.id);
            return;
        }
        const target = this.getPieceAt(move.to);
        const before = { ...piece.pos };
        if (!target) {
            // Move posIndex + cell index in lockstep with the position mutation.
            const fromKey = this.posKey(piece.pos.x, piece.pos.y);
            if (this.posIndex.get(fromKey) === piece.id)
                this.posIndex.delete(fromKey);
            this.removeFromCell(piece);
            piece.pos = move.to;
            this.posIndex.set(this.posKey(piece.pos.x, piece.pos.y), piece.id);
            this.addToCell(piece);
        }
        else if (target.ownerId === piece.ownerId) {
            // Friendly arrived first — abort this step, keep the goal so we retry.
        }
        else {
            const dx = move.to.x - move.from.x;
            const dy = move.to.y - move.from.y;
            const isDiagonal = dx !== 0 && dy !== 0;
            if (piece.type === 'pawn' && !isDiagonal) {
                // Pawns can only capture diagonally; skip the capture, piece stays put.
            }
            else if (piece.type === 'king' && target.type === 'king') {
                // Kings cannot capture each other — chess rule. The telegraph
                // shouldn't have been queued (engagementFavorable / requestMove
                // veto), but belt-and-suspenders: skip the capture and the
                // attacker stays put.
            }
            else {
                this.captureTo(piece, target, move.to);
            }
        }
        if (DEBUG) {
            const goalStr = piece.goal ? `goal=(${piece.goal.x},${piece.goal.y})` : 'goal=none';
            console.log(`[commit] ${piece.type} ${piece.id.slice(0, 4)} (${before.x},${before.y}) -> (${piece.pos.x},${piece.pos.y}) ${goalStr}`);
        }
        piece.move = undefined;
        this.movingIds.delete(piece.id);
        if (piece.goal && coordEq(piece.pos, piece.goal)) {
            piece.goal = undefined;
        }
        // Record landing square; cancel goal if the piece is just ping-ponging.
        this.recordHistoryAndCheckLoop(piece, before);
    }
    /** Apply `attacker` capturing `victim`, leaving attacker on `landing`. */
    captureTo(attacker, victim, landing) {
        const owner = this.players.get(attacker.ownerId);
        const bounty = PIECE_VALUE[victim.type];
        if (owner)
            owner.currency += bounty;
        // M5: per-piece leveling stats. Track kills + profit on the attacker
        // (resource-square income will also feed `profit` once that lands).
        attacker.kills = (attacker.kills ?? 0) + 1;
        attacker.profit = (attacker.profit ?? 0) + bounty;
        const capturedKing = victim.type === 'king';
        const capturedOwnerId = victim.ownerId;
        // Land the attacker BEFORE picking a defender: the defender will move
        // onto the attacker's NEW square, so reachability must be evaluated
        // there. Reading it from `landing` directly is equivalent but using the
        // updated `attacker.pos` keeps `scheduleRecapture` reading the same
        // source-of-truth one line down.
        const fromKey = this.posKey(attacker.pos.x, attacker.pos.y);
        if (this.posIndex.get(fromKey) === attacker.id)
            this.posIndex.delete(fromKey);
        this.removeFromCell(attacker);
        attacker.pos = landing;
        // Pick a defender to retaliate BEFORE the victim is removed (we still
        // need its formationId to find peers). removePieceById will yank the
        // victim from posIndex, then attacker takes the square.
        const defender = capturedKing ? null : this.chooseRecaptureDefender(victim, attacker);
        this.removePieceById(victim.id);
        this.posIndex.set(this.posKey(landing.x, landing.y), attacker.id);
        this.addToCell(attacker);
        if (capturedKing) {
            this.removePlayer(capturedOwnerId);
            return;
        }
        if (defender)
            this.scheduleRecapture(defender, attacker);
    }
    /**
     * Pick the cheapest formation peer that can capture the attacker on its
     * current square — but only if the trade is materially acceptable.
     *
     * Trade rule (1-ply static exchange):
     *   A defender D is acceptable iff
     *     value(D) <= value(attacker)              (we don't lose value even
     *                                               if D gets recaptured), or
     *     no enemy can immediately recapture D on the contested square
     *                                              (free capture, no counter).
     *   Otherwise we skip D and try the next-cheapest peer. If no peer
     *   qualifies, we return null and the attacker keeps its prize — better
     *   to do nothing than to feed a queen to a defended pawn.
     *
     * Formations are recomputed every tick from board geometry, so
     * membership = current recapture eligibility (and pawn stickiness).
     * Ties at the same value among acceptable defenders are broken at random.
     */
    chooseRecaptureDefender(victim, attacker) {
        if (!victim.formationId)
            return null;
        const candidates = [];
        // Occupancy lookup for line-of-sight recapture checks. Treats the
        // attacker's square as enemy so a slider's ray terminates AT the
        // attacker (capture allowed) rather than passing through it.
        const losOcc = (c) => {
            if (coordEq(c, attacker.pos))
                return 'enemy';
            return this.getOccupant(c, victim.ownerId);
        };
        const ownerSet = this.piecesByOwner.get(victim.ownerId);
        if (ownerSet)
            for (const id of ownerSet) {
                if (id === victim.id)
                    continue;
                const p = this.pieces.get(id);
                if (!p)
                    continue;
                // Formation peers: pure-geometry reach is sufficient — they live
                // packed tight and were the original recapture cohort.
                if (p.formationId === victim.formationId) {
                    if (canReachForCapture(p.type, p.level, p.pos, attacker.pos)) {
                        candidates.push(p);
                    }
                    continue;
                }
                // Knight / bishop "see-the-shot" recapture: out-of-formation
                // supports that share the victim's squad (so the player explicitly
                // grouped them with this army via formationMove) can step in iff
                // they have a real line-of-sight capture onto the attacker right
                // now. canMoveTo respects current occupancy — a bishop with a
                // friendly pawn blocking its diagonal is correctly excluded; a
                // knight's jump bypasses blockers as expected. Range-gated by
                // REGROUP_RADIUS so we don't summon supports from across the map.
                if (p.type !== 'knight' && p.type !== 'bishop')
                    continue;
                if (!victim.squadId || p.squadId !== victim.squadId)
                    continue;
                if (chebyshev(p.pos, victim.pos) > REGROUP_RADIUS)
                    continue;
                if (canMoveTo(p, attacker.pos, losOcc))
                    candidates.push(p);
            }
        if (candidates.length === 0)
            return null;
        const target = attacker.pos;
        const aVal = PIECE_VALUE[attacker.type];
        // Filter to acceptable defenders.
        //   - King: never bet the king on a defended square, regardless of value.
        //     A queen-for-queen tie is even in material but losing the king ends
        //     the run — so kings only recapture when it's a clean free take.
        //   - Other pieces: standard 1-ply rule — value(D) <= value(attacker)
        //     (no net material loss after recapture), or no enemy can recapture.
        const acceptable = candidates.filter((d) => {
            if (d.type === 'king') {
                // Kings cannot capture kings. Otherwise a king may only recapture
                // when the square is undefended (free take, no counter).
                if (attacker.type === 'king')
                    return false;
                return !this.enemyCanCapture(target, d.ownerId, d.id);
            }
            if (PIECE_VALUE[d.type] <= aVal)
                return true;
            return !this.enemyCanCapture(target, d.ownerId, d.id);
        });
        if (DEBUG && acceptable.length < candidates.length) {
            const skipped = candidates
                .filter((c) => !acceptable.includes(c))
                .map((c) => `${c.type} ${c.id.slice(0, 4)} (val ${PIECE_VALUE[c.type]} > attacker ${aVal} and defended)`)
                .join(', ');
            console.log(`[trade] skip losing recapture(s): ${skipped}`);
        }
        if (acceptable.length === 0) {
            if (DEBUG)
                console.log(`[trade] no favorable defender for ${victim.type} ${victim.id.slice(0, 4)} vs ${attacker.type} ${attacker.id.slice(0, 4)} @(${target.x},${target.y})`);
            return null;
        }
        acceptable.sort((a, b) => PIECE_VALUE[a.type] - PIECE_VALUE[b.type]);
        const lowest = PIECE_VALUE[acceptable[0].type];
        const tied = acceptable.filter((c) => PIECE_VALUE[c.type] === lowest);
        return tied[Math.floor(Math.random() * tied.length)];
    }
    /** Where a piece will be once its telegraphed move resolves. For pieces
     *  with no active move this is just `piece.pos`. Used so threat /
     *  capture-safety checks predict the board one telegraph ahead instead
     *  of reacting only to current positions (by which time it's too late). */
    imminentPos(p) {
        return p.move ? p.move.to : p.pos;
    }
    /** True if any enemy of `allyOwner` (other than `ignoreId`) can reach
     *  `square` in a single capture move from its IMMINENT position (i.e.,
     *  its telegraphed landing square if it is mid-move, else its current
     *  pos). This is the forward-looking variant — a queen telegraphing into
     *  position to fork our recapture counts as a threat the same tick the
     *  telegraph starts, not the tick it commits. */
    enemyCanCapture(square, allyOwner, ignoreId) {
        const threats = this.enemyThreats(square, allyOwner);
        if (threats.length === 0)
            return false;
        if (!ignoreId)
            return true;
        for (const id of threats)
            if (id !== ignoreId)
                return true;
        return false;
    }
    /** The cached threats list itself — lets callers that need attacker
     *  metadata (e.g. stepIsSafe wanting cheapest-value attacker) read the
     *  same memoized set instead of doing a second pass. */
    enemyThreats(square, allyOwner) {
        const key = `${square.x},${square.y}|${allyOwner}`;
        let threats = this.enemyCapCache.get(key);
        if (threats !== undefined)
            return threats;
        threats = [];
        // Max reach = SLIDER_MAX_RANGE_L2 (16) + 1 telegraph step = 17
        // squares Chebyshev between current pos and `square`. Scan cells
        // within that window: ceil(17 / 8) = 3 cells per axis, so a 7x7
        // window of cells around the query. Anything outside cannot
        // possibly reach `square` in one move.
        const cqx = square.x >> World.CELL_SHIFT;
        const cqy = square.y >> World.CELL_SHIFT;
        const R = 3;
        for (let dx = -R; dx <= R; dx++) {
            for (let dy = -R; dy <= R; dy++) {
                const cell = this.cellIndex.get(`${cqx + dx},${cqy + dy}`);
                if (!cell)
                    continue;
                for (const id of cell) {
                    const p = this.pieces.get(id);
                    if (!p || p.ownerId === allyOwner)
                        continue;
                    const pos = this.imminentPos(p);
                    if (canReachForCapture(p.type, p.level, pos, square))
                        threats.push(p.id);
                }
            }
        }
        this.enemyCapCache.set(key, threats);
        return threats;
    }
    /**
     * Idle piece looks for a single-move enemy capture it can profitably
     * make and sets that capture as its `goal`. Returns true if a goal was
     * assigned.
     *
     * Selection rules:
     *   1. Enumerate every legal one-move destination, keep only enemy
     *      occupants (treating friendlies/empties as non-targets).
     *   2. Apply `engagementFavorable` — never initiate a losing trade,
     *      never bet the king on a defended piece, never let the king
     *      touch any enemy that belongs to a formation (recapture risk
     *      to the king is unbounded).
     *   3. Rank by victim value (high first), random tie-break — when the
     *      same piece sees two equal-value targets the choice is random
     *      so two opposing armies don't deadlock into a synchronized pattern.
     *
     * Uses `enumerateMoves` directly so this works for every piece type we
     * already support and any we add later (knights, bishops, queens, rooks):
     * the engagement primitive itself is piece-agnostic.
     */
    engagementScan(piece) {
        const moves = enumerateMoves(piece.type, piece.level, piece.pos, (c) => this.getOccupant(c, piece.ownerId));
        const candidates = [];
        for (const m of moves) {
            const occ = this.getPieceAt(m);
            if (!occ || occ.ownerId === piece.ownerId)
                continue;
            if (!this.engagementFavorable(piece, occ))
                continue;
            candidates.push({ pos: m, victim: occ, val: PIECE_VALUE[occ.type] });
        }
        if (candidates.length === 0)
            return false;
        candidates.sort((a, b) => b.val - a.val);
        const top = candidates[0].val;
        const tied = candidates.filter((c) => c.val === top);
        const pick = tied[Math.floor(Math.random() * tied.length)];
        piece.goal = { x: pick.pos.x, y: pick.pos.y };
        if (DEBUG) {
            console.log(`[engage] ${piece.type} ${piece.id.slice(0, 4)}@(${piece.pos.x},${piece.pos.y}) -> capture ${pick.victim.type} ${pick.victim.id.slice(0, 4)}@(${pick.pos.x},${pick.pos.y})`);
        }
        return true;
    }
    /**
     * Idle solo piece with squad memory walks toward its nearest living
     * squadmate within REGROUP_RADIUS. Mid-combat scatter naturally reunites
     * this way without overriding active engagements or telegraphs — the
     * caller already gates on (no move, no goal, no formation). When the
     * piece arrives near the squadmate, `recomputeFormations` re-groups
     * them via the normal union-find pass and `squadId` becomes a no-op
     * until the next scatter.
     */
    regroupScan(piece) {
        if (!piece.squadId)
            return false;
        // Pieces standing on a resource square are passively earning currency
        // for their owner — never shuffle them off via regroup. Explicit
        // player moves and combat (engagement, recapture) still override
        // this; regroup is a discretionary reconvene that must yield to the
        // economy loop. Applies to both visible and hidden resources.
        if (resourceKindAt(piece.pos.x, piece.pos.y) !== null)
            return false;
        const excluded = piece.formationLeft;
        // Slot-preserving regroup: when the piece has a remembered slot in
        // the formation's rest pose, rebuild the original shape instead of
        // dog-piling onto whichever squadmate is closest. We pick the
        // lowest-id surviving slot peer as the anchor (matches the union-find
        // convention in recomputeFormations where groupId = smallest member
        // id and the anchor's slotOffset is (0,0)). Target =
        // `anchor.pos + (piece.slot - anchor.slot)` so each separated member
        // converges on the same reconstructed pose centered on the surviving
        // anchor. Falls through to the legacy "adj to nearest squadmate"
        // logic only when no slot peer is reachable or the slot square is
        // blocked — that keeps reunion possible when shape data is missing
        // (a recapturing knight, a freshly spawned support) or unworkable.
        if (piece.slotOffset && piece.formationSlotId) {
            let anchor = null;
            const ownerSet = this.piecesByOwner.get(piece.ownerId);
            if (ownerSet)
                for (const id of ownerSet) {
                    if (id === piece.id)
                        continue;
                    const p = this.pieces.get(id);
                    if (!p)
                        continue;
                    if (p.squadId !== piece.squadId)
                        continue;
                    if (p.formationSlotId !== piece.formationSlotId)
                        continue;
                    if (!p.slotOffset)
                        continue;
                    if (excluded && excluded.includes(p.id))
                        continue;
                    if (chebyshev(p.pos, piece.pos) > REGROUP_RADIUS * 2)
                        continue;
                    if (anchor === null || p.id < anchor.id)
                        anchor = p;
                }
            if (anchor) {
                const slotTarget = {
                    x: anchor.pos.x + (piece.slotOffset.x - anchor.slotOffset.x),
                    y: anchor.pos.y + (piece.slotOffset.y - anchor.slotOffset.y),
                };
                if (coordEq(slotTarget, piece.pos))
                    return false; // already at slot
                const occ = this.getPieceAt(slotTarget);
                if (!occ || occ.id === piece.id) {
                    piece.goal = slotTarget;
                    this.pieceHistory.delete(piece.id);
                    if (DEBUG) {
                        console.log(`[regroup-slot] ${piece.type} ${piece.id.slice(0, 4)}@(${piece.pos.x},${piece.pos.y}) -> slot (${slotTarget.x},${slotTarget.y}) anchor ${anchor.type} ${anchor.id.slice(0, 4)}@(${anchor.pos.x},${anchor.pos.y})`);
                    }
                    return true;
                }
            }
        }
        let nearest = null;
        let nearestDist = Infinity;
        const ownerSet = this.piecesByOwner.get(piece.ownerId);
        if (ownerSet)
            for (const id of ownerSet) {
                if (id === piece.id)
                    continue;
                const p = this.pieces.get(id);
                if (!p)
                    continue;
                if (p.squadId !== piece.squadId)
                    continue;
                // Don't rally back toward peers we've explicitly left — the player
                // (or auto-leave on a non-adjacent move) wants this piece to stay
                // detached at least until the excluded peers wander out of range.
                if (excluded && excluded.includes(p.id))
                    continue;
                const d = chebyshev(p.pos, piece.pos);
                if (d > REGROUP_RADIUS)
                    continue;
                if (d < nearestDist) {
                    nearest = p;
                    nearestDist = d;
                }
            }
        if (!nearest)
            return false;
        // Walk to an empty square ADJACENT to the squadmate, not the squadmate
        // itself — the squadmate's pos is friendly-occupied and the regrouping
        // piece would otherwise stop one tile short and idle forever. Score
        // candidates by closeness to this piece so the regroup path is short.
        // Prefer SAFE adjacent squares (no immediate enemy capture); only fall
        // back to unsafe ones when nothing safe is open. Keeps detached
        // knights/bishops from rallying directly into an enemy pawn's line.
        let target = null;
        let bestScore = Infinity;
        let unsafeTarget = null;
        let unsafeBest = Infinity;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0)
                    continue;
                const c = { x: nearest.pos.x + dx, y: nearest.pos.y + dy };
                const occ = this.getPieceAt(c);
                if (occ && occ.id !== piece.id)
                    continue; // taken by someone else
                const score = chebyshev(c, piece.pos);
                if (this.stepIsSafe(piece, c)) {
                    if (score < bestScore) {
                        bestScore = score;
                        target = c;
                    }
                }
                else if (score < unsafeBest) {
                    unsafeBest = score;
                    unsafeTarget = c;
                }
            }
        }
        if (!target)
            target = unsafeTarget;
        if (!target)
            return false; // squadmate completely walled in
        piece.goal = target;
        this.pieceHistory.delete(piece.id);
        if (DEBUG) {
            console.log(`[regroup] ${piece.type} ${piece.id.slice(0, 4)}@(${piece.pos.x},${piece.pos.y}) -> adj squadmate ${nearest.type} ${nearest.id.slice(0, 4)}@(${nearest.pos.x},${nearest.pos.y}) via (${target.x},${target.y}) dist=${nearestDist}`);
        }
        return true;
    }
    /**
     * True when `attacker` has a same-squad piece within
     * `ENGAGEMENT_SUPPORT_RADIUS` Chebyshev of `landing`. Used to gate
     * non-free engagements: a piece may only initiate an equal-or-worse-value
     * trade if a squadmate is close enough to retaliate when the attacker
     * dies on the landing square. Prevents lone pawns from sprinting deep
     * to chase down enemies their formation can't actually support.
     */
    hasSquadSupport(attacker, landing) {
        if (!attacker.squadId)
            return false;
        const ownerSet = this.piecesByOwner.get(attacker.ownerId);
        if (!ownerSet)
            return false;
        for (const id of ownerSet) {
            if (id === attacker.id)
                continue;
            const p = this.pieces.get(id);
            if (!p || p.squadId !== attacker.squadId)
                continue;
            if (chebyshev(p.pos, landing) <= ENGAGEMENT_SUPPORT_RADIUS)
                return true;
        }
        return false;
    }
    /**
     * True when `attacker` should be allowed to initiate a capture on
     * `target`. The king has special rules — losing the king ends the run,
     * so it is treated as effectively infinite-value:
     *   - Kings will not engage any piece that belongs to a formation
     *     (an in-formation victim has, by definition, friends that could
     *     recapture; the risk is unbounded).
     *   - Kings will not engage any piece on a square where ANY enemy can
     *     immediately recapture, regardless of value.
     *
     * All other pieces use the same 1-ply static-exchange rule as
     * `chooseRecaptureDefender`: trade is acceptable iff value(attacker)
     * <= value(target) (no net material loss after recapture) OR no enemy
     * can recapture on the landing square (free capture).
     */
    engagementFavorable(attacker, target) {
        if (attacker.type === 'king') {
            // Kings cannot capture other kings.
            if (target.type === 'king')
                return false;
            if (target.formationId)
                return false;
            return !this.enemyCanCapture(target.pos, attacker.ownerId, attacker.id);
        }
        const aVal = PIECE_VALUE[attacker.type];
        const tVal = PIECE_VALUE[target.type];
        const landingDefended = this.enemyCanCapture(target.pos, attacker.ownerId, attacker.id);
        // Free take: landing is undefended — always allowed regardless of trade.
        if (!landingDefended)
            return true;
        // Landing is defended. Only engage if a squadmate is in support range
        // (so the attacker's death will be answered) AND the trade isn't a net
        // material loss. This is the "stay in formation" rule: lone pieces or
        // pieces whose squadmates have scattered out of recapture range must
        // hold instead of chasing into enemy fire.
        if (aVal > tVal)
            return false;
        return this.hasSquadSupport(attacker, target.pos);
    }
    /**
     * Pre-move safety filter. True when `piece` may land on `next` without
     * blundering material. The exchange model mirrors `engagementFavorable`
     * but applied to a candidate STEP rather than a capture:
     *
     *   - Undefended landing → always safe (no one can capture us there).
     *   - Defended landing → we will lose `value(piece)`. With a squadmate
     *     in support range we recapture the cheapest attacker for a net
     *     of `cheapestAttackerVal - myVal`; safe iff that's >= 0.
     *     Without support we just die for nothing — never safe.
     *
     * Used in `tryQueueNextMove` to stop knights/bishops from blundering
     * into pawn diagonals on their way to a march target, and to make
     * formations naturally pause when the path forward is a death trap.
     * Skip on the goal square itself: an engagement / recapture goal IS
     * the dangerous square, and its trade has already been vetted by
     * `engagementFavorable` / `chooseRecaptureDefender`.
     */
    stepIsSafe(piece, next) {
        const threats = this.enemyThreats(next, piece.ownerId);
        if (threats.length === 0)
            return true;
        let cheapestAttackerVal = Infinity;
        for (const id of threats) {
            const p = this.pieces.get(id);
            if (!p)
                continue;
            const v = PIECE_VALUE[p.type];
            if (v < cheapestAttackerVal)
                cheapestAttackerVal = v;
        }
        const myVal = PIECE_VALUE[piece.type];
        if (myVal > cheapestAttackerVal)
            return false; // losing trade
        return this.hasSquadSupport(piece, next); // need backup to recapture
    }
    /**
     * An in-formation king reacts to enemy telegraphs and proximity. The scan
     * is forward-looking: each enemy is evaluated at its IMMINENT position
     * (telegraphed landing if mid-move, else current pos). The king's own
     * imminent square is used as the reference — if the king is telegraphing
     * we ask "will the square I'm about to land on be dangerous?".
     *
     * Threat classification:
     *   - CRITICAL  — either (a) an enemy is telegraphing directly onto the
     *                king's imminent square (capture-on-arrival), or (b) an
     *                enemy can capture the king's imminent square in one move
     *                from its imminent position. The king MUST move; this
     *                aborts any in-flight telegraph AND overrides any
     *                pre-existing goal.
     *   - PROXIMITY — enemy's imminent position is within KING_THREAT_RADIUS
     *                Chebyshev but cannot capture the king yet. The king
     *                retreats only if currently idle (no move, no goal); an
     *                in-flight telegraph or player march is respected.
     *
     * Retreat target:
     *   1. Identify the formation peer whose Chebyshev distance to the
     *      threat's imminent position is strictly greater than the king's —
     *      the "rear guard".
     *   2. Score each of the rear guard's 8 neighbors: empty + unreachable
     *      by any enemy = preferred, then maximize distance from threat,
     *      tie-break by closeness to the king's current position. This
     *      parks the king ADJACENT to the rear guard, inside the formation
     *      footprint — not 1+ tiles past it (which would split the group).
     *
     * Returns true if a retreat goal was set (and any in-flight move aborted).
     */
    kingSafetyScan(king) {
        if (!king.formationId)
            return false;
        const myPos = this.imminentPos(king);
        let threat = null;
        let threatDist = Infinity;
        let critical = false;
        // Only enemies near the king can possibly hit it. Max canReachForCapture
        // distance is SLIDER_MAX_RANGE_L2 (16); plus +1 for telegraph; plus
        // KING_THREAT_RADIUS for proximity. Use whichever bound is larger,
        // converted to cells. Anything outside that window is provably safe.
        const reachR = SLIDER_MAX_RANGE_L2 + 1;
        const scanR = Math.max(reachR, KING_THREAT_RADIUS);
        const R = (scanR >> World.CELL_SHIFT) + 1;
        const cqx = myPos.x >> World.CELL_SHIFT;
        const cqy = myPos.y >> World.CELL_SHIFT;
        for (let dx = -R; dx <= R; dx++) {
            for (let dy = -R; dy <= R; dy++) {
                const cell = this.cellIndex.get(`${cqx + dx},${cqy + dy}`);
                if (!cell)
                    continue;
                for (const id of cell) {
                    const p = this.pieces.get(id);
                    if (!p || p.ownerId === king.ownerId)
                        continue;
                    const pos = this.imminentPos(p);
                    // Direct: enemy is telegraphing into the square we'll land on.
                    // The enemy will commit on top of us and capture on arrival.
                    const directCapture = !!p.move && coordEq(p.move.to, myPos);
                    // Indirect: enemy from its imminent position can capture us in one
                    // more move after the current telegraph settles.
                    const indirectCapture = canReachForCapture(p.type, p.level, pos, myPos);
                    const d = chebyshev(pos, myPos);
                    const canHit = directCapture || indirectCapture;
                    if (!canHit && d > KING_THREAT_RADIUS)
                        continue;
                    if (canHit)
                        critical = true;
                    if (d < threatDist) {
                        threat = p;
                        threatDist = d;
                    }
                }
            }
        }
        if (!threat)
            return false;
        if ((king.move || king.goal) && !critical)
            return false;
        // Abort any in-flight telegraph so the king stays at king.pos and can
        // replan toward safety this tick. The replan target is computed from
        // king.pos (NOT imminent), since the abort means we never reach .move.to.
        if (king.move) {
            if (DEBUG) {
                console.log(`[king-safety] ABORT telegraph ${king.id.slice(0, 4)} (${king.move.from.x},${king.move.from.y})->(${king.move.to.x},${king.move.to.y})`);
            }
            king.move = undefined;
        }
        const threatPos = this.imminentPos(threat);
        const kingToThreat = chebyshev(king.pos, threatPos);
        let safestPeer = null;
        let safestDist = kingToThreat;
        for (const p of this.pieces.values()) {
            if (p.id === king.id)
                continue;
            if (p.ownerId !== king.ownerId)
                continue;
            if (p.formationId !== king.formationId)
                continue;
            const d = chebyshev(p.pos, threatPos);
            if (d > safestDist) {
                safestPeer = p;
                safestDist = d;
            }
        }
        // Helper: when we can't construct a safer goal, drop any stale unsafe
        // goal so the engagement scan can re-evaluate next tick instead of the
        // planner re-issuing the same suicidal telegraph (which produces a
        // visible "shake" — abort, repath, abort, repath...).
        const dropStaleGoal = (reason) => {
            if (king.goal) {
                if (DEBUG)
                    console.log(`[king-safety] CLEAR goal ${king.id.slice(0, 4)} (${king.goal.x},${king.goal.y}) — ${reason}`);
                king.goal = undefined;
                this.pieceHistory.delete(king.id);
            }
        };
        if (!safestPeer) {
            // No formation peer is further from the threat than the king — this
            // is the normal state during a forward march (king is rear-most by
            // design). Do NOT drop the king's march goal in that case: the
            // king-check in `tryQueueNextMove` will refuse any unsafe step and
            // hold position naturally. We only drop the goal when even the
            // king's CURRENT square is in enemy capture range (genuinely
            // critical — must move regardless of march intent). This prevents
            // formationMove from being self-defeating: any combat near the
            // front used to clear the king's goal and strand him at the rear.
            if (critical && this.enemyCanCapture(king.pos, king.ownerId, king.id)) {
                dropStaleGoal('no rear guard available, current pos unsafe');
            }
            return false;
        }
        // Score the KING'S OWN 8 neighbors. A king's max range is 1, so its
        // immediate next move IS its goal — picking the goal from its own
        // neighbors guarantees the next telegraph is safe. Targeting a square
        // multiple tiles away (e.g. the rear guard's neighbor) made the
        // pathfinder pick an unsafe intermediate step and looped (ABORT, repath,
        // ABORT, repath...) every tick. We still bias toward closeness to the
        // rear guard so the king walks toward his support over multiple ticks.
        const neighbors = [
            { x: king.pos.x - 1, y: king.pos.y - 1 },
            { x: king.pos.x, y: king.pos.y - 1 },
            { x: king.pos.x + 1, y: king.pos.y - 1 },
            { x: king.pos.x - 1, y: king.pos.y },
            { x: king.pos.x + 1, y: king.pos.y },
            { x: king.pos.x - 1, y: king.pos.y + 1 },
            { x: king.pos.x, y: king.pos.y + 1 },
            { x: king.pos.x + 1, y: king.pos.y + 1 },
        ];
        const pickBest = (requireSafe) => {
            let best = null;
            let bestScore = -Infinity;
            for (const c of neighbors) {
                const occ = this.getPieceAt(c);
                if (occ && occ.id !== king.id)
                    continue; // square is held by someone else
                if (requireSafe && this.enemyCanCapture(c, king.ownerId, king.id))
                    continue;
                const distToThreat = chebyshev(c, threatPos);
                const distToPeer = chebyshev(c, safestPeer.pos);
                // Distance from threat dominates; closeness to rear guard breaks ties
                // so the king drifts back into the formation footprint over time.
                const score = distToThreat * 100 - distToPeer * 10;
                if (score > bestScore) {
                    bestScore = score;
                    best = c;
                }
            }
            return best;
        };
        const target = pickBest(true) ?? pickBest(false);
        if (!target) {
            if (critical)
                dropStaleGoal('no reachable safe neighbor');
            return false;
        }
        king.goal = target;
        this.pieceHistory.delete(king.id);
        // Check-response: the chess rule "you must address the check ASAP" —
        // pick the cheapest non-king squadmate that can immediately capture
        // the threat at its imminent position and assign threat.pos as its
        // goal. Captures the attacker → breaks the check at the source.
        // Non-king filter: kings cannot capture kings (and trading the king
        // for a threat would be self-defeating anyway). We DO override the
        // 1-ply trade gate here on purpose: losing a pawn to save the king
        // is always correct, since losing the king ends the run.
        let breaker = null;
        let breakerVal = Infinity;
        if (king.squadId) {
            const ownerSet = this.piecesByOwner.get(king.ownerId);
            if (ownerSet)
                for (const id of ownerSet) {
                    if (id === king.id)
                        continue;
                    const p = this.pieces.get(id);
                    if (!p)
                        continue;
                    if (p.type === 'king')
                        continue;
                    if (p.squadId !== king.squadId)
                        continue;
                    if (p.frozenUntilTick && p.frozenUntilTick > this.tick)
                        continue;
                    if (p.lockedUntilTick && p.lockedUntilTick > this.tick)
                        continue;
                    if (!canReachForCapture(p.type, p.level, p.pos, threatPos))
                        continue;
                    const v = PIECE_VALUE[p.type];
                    if (v < breakerVal) {
                        breakerVal = v;
                        breaker = p;
                    }
                }
        }
        if (breaker) {
            breaker.goal = { x: threatPos.x, y: threatPos.y };
            breaker.move = undefined;
            this.pieceHistory.delete(breaker.id);
            if (DEBUG) {
                console.log(`[king-safety] BREAK-CHECK ${breaker.type} ${breaker.id.slice(0, 4)}@(${breaker.pos.x},${breaker.pos.y}) -> capture threat ${threat.type} ${threat.id.slice(0, 4)}@(${threatPos.x},${threatPos.y})`);
            }
        }
        // Tell the squad combat just broke out — drop every squadmate's
        // current goal so engagementScan (gates on !piece.goal, runs next in
        // step()) re-evaluates them this same tick. Translating goals by the
        // king's retreat delta produces phantom empty squares; pawns then
        // chase those instead of engaging the enemies right next to them.
        // After clearing: engagementScan attacks any 1-move favorable victim
        // (combat > positioning), and regroupScan trails the king for the
        // rest (king is normally the nearest squadmate inside REGROUP_RADIUS).
        if (king.squadId) {
            for (const p of this.pieces.values()) {
                if (p.id === king.id)
                    continue;
                if (p.squadId !== king.squadId)
                    continue;
                if (p === breaker)
                    continue; // breaker keeps its check-capture goal
                if (p.move)
                    continue; // already telegraphing; let it land
                p.goal = undefined;
                this.pieceHistory.delete(p.id);
            }
        }
        if (DEBUG) {
            const threatLoc = threat.move
                ? `@(${threat.pos.x},${threat.pos.y})->@(${threatPos.x},${threatPos.y})`
                : `@(${threatPos.x},${threatPos.y})`;
            console.log(`[king-safety] CRITICAL ${king.id.slice(0, 4)}@(${king.pos.x},${king.pos.y}) threat=${threat.type} ${threat.id.slice(0, 4)}${threatLoc} -> retreat (${target.x},${target.y}) adjacent ${safestPeer.type} ${safestPeer.id.slice(0, 4)}@(${safestPeer.pos.x},${safestPeer.pos.y})`);
        }
        return true;
    }
    /**
     * Idle king that's drifted away from its squad walks back to the tail
     * end of the formation — adjacent to the nearest squadmate, on the side
     * AWAY from the nearest enemy. Without this, a king that retreated to a
     * safe corner during a check stays there forever while its formation
     * pushes forward into the next fight (the bug from last game: "Blue king
     * ran away and stayed put").
     *
     * Gating:
     *   - king must be idle (no goal, no move, not frozen/locked).
     *   - must have a `squadId` (it was once in a formation).
     *   - must have a living squadmate within REGROUP_RADIUS to follow.
     *   - if king is already adjacent to a squadmate AND its current
     *     square is safe, do nothing — already at the tail end.
     *
     * Target choice: pick the square adjacent to the nearest squadmate
     * that maximizes distance from the nearest enemy (subject to being
     * empty and out of enemy capture range). Ties broken by closeness
     * to the king's current pos so movement is incremental.
     */
    kingFollowScan(king) {
        if (king.type !== 'king')
            return false;
        if (king.move || king.goal)
            return false;
        if (king.frozenUntilTick && king.frozenUntilTick > this.tick)
            return false;
        if (king.lockedUntilTick && king.lockedUntilTick > this.tick)
            return false;
        if (!king.squadId)
            return false;
        const squadmates = [];
        const ownerSet = this.piecesByOwner.get(king.ownerId);
        if (ownerSet)
            for (const id of ownerSet) {
                if (id === king.id)
                    continue;
                const p = this.pieces.get(id);
                if (!p)
                    continue;
                if (p.squadId !== king.squadId)
                    continue;
                if (chebyshev(p.pos, king.pos) <= REGROUP_RADIUS)
                    squadmates.push(p);
            }
        if (squadmates.length === 0)
            return false;
        const adjToSquadmate = squadmates.some((p) => chebyshev(p.pos, king.pos) === 1);
        const safeNow = !this.enemyCanCapture(king.pos, king.ownerId, king.id);
        if (adjToSquadmate && safeNow)
            return false;
        // Nearest squadmate to walk toward.
        let nearestSquadmate = squadmates[0];
        let nsDist = chebyshev(nearestSquadmate.pos, king.pos);
        for (const p of squadmates) {
            const d = chebyshev(p.pos, king.pos);
            if (d < nsDist) {
                nsDist = d;
                nearestSquadmate = p;
            }
        }
        // Nearest enemy — bias king away from combat ("tail end").
        let nearestEnemy = null;
        let nearestEnemyDist = Infinity;
        for (const p of this.pieces.values()) {
            if (p.ownerId === king.ownerId)
                continue;
            const pos = this.imminentPos(p);
            const d = chebyshev(pos, nearestSquadmate.pos);
            if (d < nearestEnemyDist) {
                nearestEnemyDist = d;
                nearestEnemy = p;
            }
        }
        const enemyPos = nearestEnemy ? this.imminentPos(nearestEnemy) : null;
        // Score neighbors of nearestSquadmate: safe + far from enemy + close to king.
        let bestTarget = null;
        let bestScore = -Infinity;
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0)
                    continue;
                const c = { x: nearestSquadmate.pos.x + dx, y: nearestSquadmate.pos.y + dy };
                const occ = this.getPieceAt(c);
                if (occ && occ.id !== king.id)
                    continue;
                if (this.enemyCanCapture(c, king.ownerId, king.id))
                    continue;
                const distFromEnemy = enemyPos ? chebyshev(c, enemyPos) : 100;
                const distToKing = chebyshev(c, king.pos);
                const score = distFromEnemy * 100 - distToKing;
                if (score > bestScore) {
                    bestScore = score;
                    bestTarget = c;
                }
            }
        }
        if (!bestTarget)
            return false;
        if (coordEq(bestTarget, king.pos))
            return false;
        king.goal = bestTarget;
        this.pieceHistory.delete(king.id);
        if (DEBUG) {
            console.log(`[king-follow] ${king.id.slice(0, 4)}@(${king.pos.x},${king.pos.y}) -> tail (${bestTarget.x},${bestTarget.y}) adj ${nearestSquadmate.type} ${nearestSquadmate.id.slice(0, 4)}@(${nearestSquadmate.pos.x},${nearestSquadmate.pos.y})${enemyPos ? ` away from enemy@(${enemyPos.x},${enemyPos.y})` : ''}`);
        }
        return true;
    }
    /**
     * Issue `defender` a goal at the capturer's square and lock the capturer in
     * place long enough for the defender to telegraph there. If the defender is
     * already busy with a move/goal we overwrite — retaliation takes priority.
     */
    scheduleRecapture(defender, capturer) {
        defender.goal = { ...capturer.pos };
        const telegraphTicks = Math.max(1, Math.round(telegraphMsFor(defender.type, defender.level, defender.pos, capturer.pos) / TICK_MS));
        capturer.lockedUntilTick = this.tick + telegraphTicks + RECAPTURE_LOCK_BUFFER_TICKS;
        capturer.move = undefined;
        capturer.goal = undefined;
        if (DEBUG) {
            console.log(`[recapture] ${defender.type} ${defender.id.slice(0, 4)} -> capturer ${capturer.type} ${capturer.id.slice(0, 4)} @(${capturer.pos.x},${capturer.pos.y}), lock until tick ${capturer.lockedUntilTick}`);
        }
        if (!defender.frozenUntilTick || defender.frozenUntilTick <= this.tick) {
            defender.move = undefined;
            this.tryQueueNextMove(defender);
        }
    }
    /** Remove a piece from the world. */
    removePieceById(id) {
        const piece = this.pieces.get(id);
        if (piece) {
            const k = this.posKey(piece.pos.x, piece.pos.y);
            if (this.posIndex.get(k) === id)
                this.posIndex.delete(k);
            this.removeFromCell(piece);
            const ownerSet = this.piecesByOwner.get(piece.ownerId);
            if (ownerSet) {
                ownerSet.delete(id);
                if (ownerSet.size === 0)
                    this.piecesByOwner.delete(piece.ownerId);
            }
            this.movingIds.delete(id);
        }
        this.pieces.delete(id);
        this.pieceHistory.delete(id);
    }
    /**
     * Find pairs of pieces whose moves both end this tick and swap squares with
     * each other. Higher PIECE_VALUE captures the lower; on a tie both moves are
     * cancelled and both pieces are intimidated (briefly frozen).
     */
    resolveMutualAttacks() {
        const arriving = [];
        for (const piece of this.pieces.values()) {
            if (piece.move && piece.move.endTick <= this.tick)
                arriving.push(piece);
        }
        const handled = new Set();
        for (let i = 0; i < arriving.length; i++) {
            const a = arriving[i];
            if (handled.has(a.id) || !this.pieces.has(a.id))
                continue;
            for (let j = i + 1; j < arriving.length; j++) {
                const b = arriving[j];
                if (handled.has(b.id) || !this.pieces.has(b.id))
                    continue;
                if (a.ownerId === b.ownerId)
                    continue;
                if (coordEq(a.move.to, b.pos) && coordEq(b.move.to, a.pos)) {
                    const av = PIECE_VALUE[a.type];
                    const bv = PIECE_VALUE[b.type];
                    if (av > bv) {
                        const aFrom = { ...a.move.from };
                        this.captureTo(a, b, b.pos);
                        a.move = undefined;
                        if (a.goal && coordEq(a.pos, a.goal))
                            a.goal = undefined;
                        this.recordHistoryAndCheckLoop(a, aFrom);
                    }
                    else if (bv > av) {
                        const bFrom = { ...b.move.from };
                        this.captureTo(b, a, a.pos);
                        b.move = undefined;
                        if (b.goal && coordEq(b.pos, b.goal))
                            b.goal = undefined;
                        this.recordHistoryAndCheckLoop(b, bFrom);
                    }
                    else {
                        // Tie: both back off, both intimidated.
                        a.move = undefined;
                        b.move = undefined;
                        a.frozenUntilTick = this.tick + INTIMIDATION_FREEZE_TICKS;
                        b.frozenUntilTick = this.tick + INTIMIDATION_FREEZE_TICKS;
                    }
                    handled.add(a.id);
                    handled.add(b.id);
                    break;
                }
            }
        }
    }
    /** Track recent destinations and cancel the goal on any-length cycle. */
    recordHistoryAndCheckLoop(piece, from) {
        let hist = this.pieceHistory.get(piece.id);
        if (!hist) {
            hist = [];
            this.pieceHistory.set(piece.id, hist);
            // Seed with the previous square so `forbidden` (hist[length-2]) is
            // valid from the very first follow-up plan, preventing greedy from
            // immediately reversing A*'s opening detour.
            if (from && !coordEq(from, piece.pos))
                hist.push({ ...from });
        }
        hist.push({ ...piece.pos });
        if (hist.length > OSCILLATION_HISTORY)
            hist.splice(0, hist.length - OSCILLATION_HISTORY);
        // Any-length cycle: if the latest landing square appears earlier in the
        // recent window, the piece is orbiting a blocker and will never escape.
        // Cancel the goal so it stops fidgeting and the player can re-issue.
        const last = hist[hist.length - 1];
        for (let i = 0; i < hist.length - 1; i++) {
            if (coordEq(hist[i], last)) {
                if (DEBUG)
                    console.log(`[loop] CANCEL ${piece.type} ${piece.id.slice(0, 4)} revisits (${last.x},${last.y}); goal dropped`);
                piece.goal = undefined;
                hist.length = 0;
                return;
            }
        }
    }
    tryQueueNextMove(piece) {
        const goal = piece.goal;
        if (!goal)
            return;
        // Formation stagger: if this piece is running far ahead of the slowest
        // formation member's remaining distance, hold one tick so the group
        // re-cohesss instead of stringing out single file.
        if (piece.formationId && this.formationLeaderShouldWait(piece))
            return;
        // Use the piece's previous landing square (if any) as a forbidden first step,
        // so greedy and A* can never undo each other's progress and oscillate.
        const hist = this.pieceHistory.get(piece.id);
        const prev = hist && hist.length >= 2 ? hist[hist.length - 2] : null;
        // Formation lockstep: prefer the shared unit step toward the formation's
        // common direction. If the preferred cell holds a formation peer that
        // hasn't planned yet, return without queuing — the cascade plan loop
        // will re-try this piece after the peer has telegraphed away.
        //
        // We deliberately do NOT apply `prev`-forbidden to the formation step:
        // when the player reverses a march, every member's lockstep next square
        // IS the one it just came from, and rejecting it would force each piece
        // to detour around the formation and shatter the shape. The formation
        // step is `sign(goal - pos)` and is monotonic for a fixed goal, so it
        // cannot oscillate on its own; any actual cycle (e.g. obstacle bounce)
        // is still caught by `recordHistoryAndCheckLoop` after the fact.
        let next = null;
        const preferEmpty = (c) => !this.isFriendlyCurrentlyAt(c, piece.id, piece.ownerId);
        // Skip formation lockstep when the goal is one tile away — there is
        // nothing to coordinate, and the ortho-axis collapse will mis-route
        // a 1-step diagonal goal (e.g. king-safety retreat to (-1,-1)) into
        // an unsafe ortho neighbor (-1, 0), triggering the abort/repath loop.
        // Multi-tile player marches still use lockstep so the formation shape
        // stays rigid during travel.
        const goalIsAdjacent = chebyshev(piece.pos, goal) <= 1;
        // Formation lockstep only applies to coordinated marches: the piece must
        // both belong to a formation AND its current `goal` must still match the
        // `formationGoal` snapshot stamped by formationMove. Any later goal-set
        // (engagement, regroup, recapture, king-safety) overwrites `goal` without
        // touching `formationGoal`, so the equality check below fails and we
        // route through the natural pathfinder — letting sliders use their full
        // range instead of crawling 1 square per tick.
        const onFormationMarch = !!piece.formationGoal && coordEq(piece.formationGoal, goal);
        if (piece.formationId && onFormationMarch && !goalIsAdjacent) {
            const fr = this.formationPreferredStep(piece);
            if (fr.pending)
                return;
            if (fr.step) {
                next = fr.step;
            }
            else {
                next = pathfindNextMove(piece, goal, (c) => this.getOccupant(c, piece.ownerId), prev ?? null, preferEmpty);
            }
        }
        else {
            next = pathfindNextMove(piece, goal, (c) => this.getOccupant(c, piece.ownerId), prev ?? null, preferEmpty);
        }
        if (!next) {
            // Temporary block (friendly in the way, formation peer not yet
            // telegraphed, etc.). Hold position and re-plan next tick rather than
            // dropping the goal — dropping causes trailing formation members to
            // give up the instant a teammate steals their lockstep square. Genuine
            // oscillation is still caught by `recordHistoryAndCheckLoop` once the
            // piece actually starts landing on squares.
            return;
        }
        if (this.isFriendlyTargeting(next, piece.ownerId, piece.id))
            return;
        // Kings cannot move onto a square that puts them in check. If the
        // planner picked an unsafe step (lockstep ortho-collapse, greedy
        // chase toward an offset goal that runs through enemy range, etc.),
        // search the king's other neighbors for the safest step that still
        // makes progress toward the goal. If nothing safe exists, hold.
        if (piece.type === 'king' && this.enemyCanCapture(next, piece.ownerId, piece.id)) {
            const currentDist = chebyshev(piece.pos, goal);
            let alt = null;
            let altDist = currentDist;
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0)
                        continue;
                    const c = { x: piece.pos.x + dx, y: piece.pos.y + dy };
                    const occ = this.getPieceAt(c);
                    if (occ && occ.ownerId === piece.ownerId)
                        continue;
                    if (this.enemyCanCapture(c, piece.ownerId, piece.id))
                        continue;
                    const d = chebyshev(c, goal);
                    if (d < altDist) {
                        altDist = d;
                        alt = c;
                    }
                }
            }
            if (!alt) {
                if (DEBUG)
                    console.log(`[king-check] ${piece.id.slice(0, 4)} refuses step (${next.x},${next.y}) toward goal (${goal.x},${goal.y}) — no safe alternative, holding`);
                return;
            }
            if (DEBUG)
                console.log(`[king-check] ${piece.id.slice(0, 4)} reroute (${next.x},${next.y}) -> (${alt.x},${alt.y}) — original step in check`);
            next = alt;
            if (this.isFriendlyTargeting(next, piece.ownerId, piece.id))
                return;
        }
        // Step-safety for non-king pieces: if the planned step lands on a
        // square where we'd lose material (defended landing, no profitable
        // recapture), search legal alternative steps for a safer one that
        // still makes progress toward `goal`. If nothing safe makes
        // progress, hold this tick rather than blunder. Skip when stepping
        // ONTO the goal — engagement/recapture goals have already been
        // value-checked by `engagementFavorable` / `chooseRecaptureDefender`.
        if (piece.type !== 'king' && !coordEq(next, goal) && !this.stepIsSafe(piece, next)) {
            const occFor = (c) => this.getOccupant(c, piece.ownerId);
            const alts = enumerateMoves(piece.type, piece.level, piece.pos, occFor);
            const currentDist = distanceFor(piece.type, piece.pos, goal);
            let safer = null;
            let saferDist = currentDist;
            for (const c of alts) {
                if (coordEq(c, next))
                    continue;
                if (this.isFriendlyTargeting(c, piece.ownerId, piece.id))
                    continue;
                if (!this.stepIsSafe(piece, c))
                    continue;
                const d = distanceFor(piece.type, c, goal);
                if (d < saferDist) {
                    saferDist = d;
                    safer = c;
                }
            }
            if (!safer) {
                if (DEBUG_SAFETY)
                    console.log(`[safety] ${piece.type} ${piece.id.slice(0, 4)} refuses unsafe step (${next.x},${next.y}) toward (${goal.x},${goal.y}) — holding`);
                return;
            }
            if (DEBUG_SAFETY)
                console.log(`[safety] ${piece.type} ${piece.id.slice(0, 4)} reroute (${next.x},${next.y}) -> (${safer.x},${safer.y}) — original unsafe`);
            next = safer;
            if (this.isFriendlyTargeting(next, piece.ownerId, piece.id))
                return;
        }
        const ms = telegraphMsFor(piece.type, piece.level, piece.pos, next);
        const ticks = Math.max(1, Math.round(ms / TICK_MS));
        // "Follow mode": if a friendly piece is currently telegraphing OFF of
        // `next`, our telegraph runs *in parallel* with theirs and ends no
        // earlier than they end — so we arrive on the same tick the cell is
        // vacated. This keeps formations rigid even when telegraph durations
        // differ (a slow queen ahead of a fast pawn will still pull the pawn
        // along; the pawn's commit just waits for the queen's commit).
        const friendEnd = this.friendlyVacatingEndTick(next, piece.ownerId);
        const startTick = this.tick;
        const endTick = Math.max(startTick + ticks, friendEnd);
        piece.move = {
            from: { ...piece.pos },
            to: { ...next },
            startTick,
            endTick,
        };
        this.movingIds.add(piece.id);
    }
    /** EndTick of any friendly piece currently telegraphing AWAY from `c`, or 0 if none. */
    friendlyVacatingEndTick(c, ownerId) {
        let best = 0;
        for (const id of this.movingIds) {
            const piece = this.pieces.get(id);
            if (!piece || !piece.move || piece.ownerId !== ownerId)
                continue;
            if (!coordEq(piece.move.from, c))
                continue;
            if (piece.move.endTick > best)
                best = piece.move.endTick;
        }
        return best;
    }
    /**
     * Rebuild every piece's `formationId` from current board geometry. Pieces
     * are unioned into a formation when:
     *   (a) either side can capture onto the other's square in one move, or
     *   (b) "pawn stickiness": a pawn is adjacent (chebyshev=1) to a friendly
     *       king / queen / rook.
     * Only formation-eligible types (king, queen, rook, pawn) participate.
     * The id of each group is the smallest pieceId in it, so it stays stable
     * across ticks until membership actually changes.
     */
    recomputeFormations() {
        // Prune `formationLeft` exclusion lists first: any peer that is no
        // longer chebyshev-adjacent (or has been removed entirely) is dropped,
        // so a piece that has walked away and circled back can re-join its
        // old formation organically. When the list goes empty we delete the
        // field so the piece is fully back in the auto-formation pool.
        for (const p of this.pieces.values()) {
            if (!p.formationLeft || p.formationLeft.length === 0)
                continue;
            p.formationLeft = p.formationLeft.filter((id) => {
                const peer = this.pieces.get(id);
                return peer !== undefined && chebyshev(peer.pos, p.pos) <= 1;
            });
            if (p.formationLeft.length === 0)
                p.formationLeft = undefined;
        }
        const parent = new Map();
        for (const p of this.pieces.values()) {
            p.formationId = undefined;
            parent.set(p.id, p.id);
        }
        const find = (a) => {
            let r = a;
            while (parent.get(r) !== r)
                r = parent.get(r);
            let cur = a;
            while (parent.get(cur) !== r) {
                const next = parent.get(cur);
                parent.set(cur, r);
                cur = next;
            }
            return r;
        };
        const union = (a, b) => {
            const ra = find(a);
            const rb = find(b);
            if (ra !== rb)
                parent.set(ra, rb);
        };
        const eligible = new Set(FORMATION_ELIGIBLE_TYPES);
        // Use the per-owner piece index so the O(M^2) link-test loop is
        // bounded by ONE player's piece count instead of the whole world.
        // Two armies never share a formation, so cross-owner pairs are
        // wasted work.
        const pieces = [];
        for (const [ownerId, ids] of this.piecesByOwner) {
            const owned = [];
            for (const id of ids) {
                const p = this.pieces.get(id);
                if (!p || !eligible.has(p.type))
                    continue;
                owned.push(p);
                pieces.push(p);
            }
            void ownerId;
            for (let i = 0; i < owned.length; i++) {
                const a = owned[i];
                for (let j = i + 1; j < owned.length; j++) {
                    const b = owned[j];
                    // Honor explicit "I left this formation" exclusions either direction.
                    if (a.formationLeft?.includes(b.id))
                        continue;
                    if (b.formationLeft?.includes(a.id))
                        continue;
                    if (this.formationLinked(a, b))
                        union(a.id, b.id);
                }
            }
        }
        const groups = new Map();
        for (const p of pieces) {
            const r = find(p.id);
            const arr = groups.get(r) ?? [];
            arr.push(p.id);
            groups.set(r, arr);
        }
        for (const members of groups.values()) {
            if (members.length < 2)
                continue;
            members.sort();
            const groupId = members[0];
            for (const id of members) {
                const piece = this.pieces.get(id);
                if (!piece)
                    continue;
                piece.formationId = groupId;
                // Persistent squad memory: capture the FIRST formation this piece
                // joins as its permanent squad id. Survives combat scatter — a
                // piece that later goes solo still remembers who it belongs to,
                // so kingSafetyScan and regroupScan can reunite the original
                // group instead of treating split-off pieces as strangers.
                piece.squadId ??= groupId;
            }
        }
        // Slot capture / refresh. For every formation, if all members are at
        // rest (no telegraphed move, no goal) AND any member's stored slot is
        // stale (formationSlotId !== current formationId, or slotOffset is
        // missing), snapshot the current shape as the formation's rest pose:
        // each member's slotOffset = (member.pos - anchor.pos), where anchor
        // is the smallest-id member (== groupId). The anchor's own slot is
        // (0,0) by construction. These slots are then used by formationMove
        // to preserve the shape on retarget instead of reading the (possibly
        // stretched) current positions.
        for (const [, members] of groups) {
            if (members.length < 2)
                continue;
            members.sort();
            const groupId = members[0];
            let atRest = true;
            let stale = false;
            for (const id of members) {
                const p = this.pieces.get(id);
                if (!p)
                    continue;
                if (p.move || p.goal) {
                    atRest = false;
                    break;
                }
                if (p.formationSlotId !== groupId || p.slotOffset === undefined) {
                    stale = true;
                }
            }
            if (!atRest || !stale)
                continue;
            const anchor = this.pieces.get(groupId);
            if (!anchor)
                continue;
            for (const id of members) {
                const p = this.pieces.get(id);
                if (!p)
                    continue;
                p.slotOffset = { x: p.pos.x - anchor.pos.x, y: p.pos.y - anchor.pos.y };
                p.formationSlotId = groupId;
            }
            if (DEBUG) {
                const shape = members
                    .map((id) => {
                    const p = this.pieces.get(id);
                    return `${p.type} ${id.slice(0, 4)}(${p.slotOffset.x},${p.slotOffset.y})`;
                })
                    .join(', ');
                console.log(`[slot] capture fid=${groupId.slice(0, 4)} [${shape}]`);
            }
        }
        if (DEBUG) {
            // Log only when membership changed since last tick (noise control).
            let changed = false;
            for (const p of this.pieces.values()) {
                const prev = this.lastFormationIds.get(p.id);
                if (prev !== p.formationId) {
                    changed = true;
                    break;
                }
            }
            if (!changed) {
                // Also detect pieces that disappeared
                for (const id of this.lastFormationIds.keys()) {
                    if (!this.pieces.has(id)) {
                        changed = true;
                        break;
                    }
                }
            }
            if (changed) {
                const groupSummary = [];
                for (const [groupId, members] of groups) {
                    if (members.length < 2)
                        continue;
                    const root = find(groupId);
                    const memberList = members
                        .map((id) => {
                        const piece = this.pieces.get(id);
                        return piece ? `${piece.type} ${id.slice(0, 4)}@(${piece.pos.x},${piece.pos.y})` : id.slice(0, 4);
                    })
                        .join(', ');
                    groupSummary.push(`{${root.slice(0, 4)}: ${memberList}}`);
                }
                const soloIds = [];
                for (const p of pieces) {
                    if (!p.formationId)
                        soloIds.push(`${p.type} ${p.id.slice(0, 4)}`);
                }
                console.log(`[formation] tick ${this.tick} groups=[${groupSummary.join(' ')}] solo=[${soloIds.join(', ')}]`);
            }
            this.lastFormationIds.clear();
            for (const p of this.pieces.values())
                this.lastFormationIds.set(p.id, p.formationId);
        }
    }
    /** Last-tick formationId per piece, used solely to log membership diffs. */
    lastFormationIds = new Map();
    /** True if `a` and `b` should belong to the same formation right now. */
    formationLinked(a, b) {
        // Pawn stickiness: pawn next to a friendly king/queen/rook (any of the 8 squares).
        const aPawn = a.type === 'pawn';
        const bPawn = b.type === 'pawn';
        const aHeavy = a.type === 'king' || a.type === 'queen' || a.type === 'rook';
        const bHeavy = b.type === 'king' || b.type === 'queen' || b.type === 'rook';
        if (((aPawn && bHeavy) || (bPawn && aHeavy)) && chebyshev(a.pos, b.pos) === 1)
            return true;
        // Recapture eligibility either way.
        if (canReachForCapture(a.type, a.level, a.pos, b.pos))
            return true;
        if (canReachForCapture(b.type, b.level, b.pos, a.pos))
            return true;
        return false;
    }
    /**
     * Compute the one-square step `piece` should take to keep formation.
     *
     *   `pending: true`  — the preferred cell holds a formation peer that has
     *                     not planned its move yet. Return without queuing so
     *                     the cascade plan loop can re-try this piece after
     *                     the peer telegraphs away.
     *   `step: Coord`    — take this step (cell is empty, vacating, or an
     *                     enemy we may capture in that direction).
     *   `step: null,
     *    pending: false` — no useful formation step; fall through to greedy/A*.
     */
    formationPreferredStep(piece) {
        if (!piece.goal)
            return { step: null, pending: false };
        const dxRaw = piece.goal.x - piece.pos.x;
        const dyRaw = piece.goal.y - piece.pos.y;
        if (dxRaw === 0 && dyRaw === 0)
            return { step: null, pending: false };
        let sx = Math.sign(dxRaw);
        let sy = Math.sign(dyRaw);
        // Lockstep: every formation member (king, queen, rook, pawn) collapses
        // its step to the dominant axis. Because each member's individual goal
        // is the shared (anchor.pos + delta), they all see the same (dxRaw,dyRaw)
        // and therefore pick the same axis — so the whole group translates one
        // ortho tile per tick and the formation shape is preserved through
        // diagonal marches. Without this the king would step diagonally while
        // pawns stepped ortho, immediately distorting the shape.
        if (piece.formationId || piece.type === 'pawn' || piece.type === 'rook') {
            if (Math.abs(dxRaw) >= Math.abs(dyRaw))
                sy = 0;
            else
                sx = 0;
        }
        if (sx === 0 && sy === 0)
            return { step: null, pending: false };
        const next = { x: piece.pos.x + sx, y: piece.pos.y + sy };
        // Pawns can only capture diagonally. Any step where one axis is zero
        // is an orthogonal move, so a pawn must NEVER plan an ortho step onto
        // an enemy — the commit will refuse the capture, the piece will land
        // back on its own square as a no-op, and the loop-cancel will drop
        // the goal. Fall through so the proper pathfinder can find a real
        // diagonal capture instead.
        const pawnOrthoBlocked = piece.type === 'pawn' && (sx === 0 || sy === 0);
        for (const other of this.pieces.values()) {
            if (other.id === piece.id)
                continue;
            if (!other.move && coordEq(other.pos, next)) {
                if (other.ownerId === piece.ownerId) {
                    // Friendly sitting on our target. If they're a formation peer
                    // with a goal, they will plan a step soon — wait for cascade.
                    if (other.formationId === piece.formationId && other.goal) {
                        return { step: null, pending: true };
                    }
                    return { step: null, pending: false };
                }
                // Enemy occupant.
                if (pawnOrthoBlocked)
                    return { step: null, pending: false };
                return { step: next, pending: false };
            }
            if (other.move && coordEq(other.move.to, next)) {
                if (other.ownerId === piece.ownerId)
                    return { step: null, pending: false };
                if (pawnOrthoBlocked)
                    return { step: null, pending: false };
                return { step: next, pending: false };
            }
            // Friendly vacating `next` is fine; we slot into it on arrival.
        }
        return { step: next, pending: false };
    }
    /** True when this piece is sprinting too far ahead of its formation peers
     *  with goals (measured as Chebyshev tile-distance — the natural
     *  per-tick advance rate of a marching formation) and should hold a tick
     *  to let them catch up. Cap at FORMATION_STAGGER_MAX. We deliberately
     *  do NOT use each piece's own `distanceFor`: a pawn's manhattan and a
     *  king's chebyshev to the same diagonal goal differ by a large constant
     *  factor, which would (and did) force the king to wait forever.
     *  With auto-formations, `formationId` is owned by recomputeFormations —
     *  we never mutate it here.
     */
    formationLeaderShouldWait(piece) {
        const fid = piece.formationId;
        if (!fid || !piece.goal)
            return false;
        let othersExist = false;
        let maxOtherRemaining = 0;
        for (const other of this.pieces.values()) {
            if (other.id === piece.id || other.formationId !== fid)
                continue;
            if (!other.goal)
                continue;
            othersExist = true;
            const r = chebyshev(other.pos, other.goal);
            if (r > maxOtherRemaining)
                maxOtherRemaining = r;
        }
        if (!othersExist)
            return false;
        const mine = chebyshev(piece.pos, piece.goal);
        return mine + FORMATION_STAGGER_MAX < maxOtherRemaining;
    }
    /**
     * Occupancy from a given player's perspective. We reserve a friendly piece's
     * telegraphed landing square so two of our pieces won't try to occupy it.
     * Enemy landings are NOT reserved — we are happy to race them (and capture).
     */
    getOccupant(c, viewerOwnerId) {
        const k = this.posKey(c.x, c.y);
        // Holes are terrain: impassable for everyone, can't be captured or
        // slid through. Checked first so move enumeration treats them like
        // an immovable wall regardless of whose perspective is asking.
        if (this.holes.has(k))
            return 'blocked';
        const idAtPos = this.posIndex.get(k);
        if (idAtPos) {
            const p = this.pieces.get(idAtPos);
            if (!p.move)
                return p.ownerId === viewerOwnerId ? 'friendly' : 'enemy';
            // Piece is mid-move from c. Enemy still counts as enemy until its
            // telegraph commits. A friendly leaving c frees the square — fall
            // through so a follower can plan into it.
            if (p.ownerId !== viewerOwnerId)
                return 'enemy';
        }
        // Check FRIENDLY landings only (enemy landings are races we accept).
        // movingIds is small; iterating it is much cheaper than pieces.values().
        for (const id of this.movingIds) {
            if (id === idAtPos)
                continue;
            const p = this.pieces.get(id);
            if (!p || !p.move || p.ownerId !== viewerOwnerId)
                continue;
            if (coordEq(p.move.to, c))
                return 'friendly';
        }
        return 'empty';
    }
    /** True if some other friendly piece currently SITS on `c` (current `pos`
     *  only — telegraphs ignored). Used as a pathfind tie-break: when two
     *  candidate moves reduce distance equally, prefer the one whose target
     *  square no friendly is currently standing on, so a king doesn't queue
     *  a telegraph that visibly aims at a pawn that's about to step aside. */
    isFriendlyCurrentlyAt(c, excludeId, ownerId) {
        const id = this.posIndex.get(this.posKey(c.x, c.y));
        if (!id || id === excludeId)
            return false;
        const piece = this.pieces.get(id);
        return !!piece && piece.ownerId === ownerId;
    }
    isFriendlyTargeting(c, ownerId, excludePieceId) {
        // Already idle on `c`? posIndex gives us that piece in O(1). A
        // friendly *leaving* `c` (has a move) does NOT block — we queue
        // behind them.
        const idAtPos = this.posIndex.get(this.posKey(c.x, c.y));
        if (idAtPos && idAtPos !== excludePieceId) {
            const p = this.pieces.get(idAtPos);
            if (p && p.ownerId === ownerId && !p.move)
                return true;
        }
        // Friendly telegraphing INTO `c`: scan only movingIds, small set.
        for (const id of this.movingIds) {
            if (id === excludePieceId)
                continue;
            const p = this.pieces.get(id);
            if (!p || !p.move || p.ownerId !== ownerId)
                continue;
            if (coordEq(p.move.to, c))
                return true;
        }
        return false;
    }
    getPieceAt(c) {
        const id = this.posIndex.get(this.posKey(c.x, c.y));
        return id ? this.pieces.get(id) : undefined;
    }
    spawnPiece(ownerId, type, pos) {
        const piece = {
            id: randomUUID(),
            ownerId,
            type,
            level: 1,
            pos: { ...pos },
            bornTick: this.tick,
        };
        this.pieces.set(piece.id, piece);
        this.posIndex.set(this.posKey(piece.pos.x, piece.pos.y), piece.id);
        this.addToCell(piece);
        let ownerSet = this.piecesByOwner.get(ownerId);
        if (!ownerSet) {
            ownerSet = new Set();
            this.piecesByOwner.set(ownerId, ownerSet);
        }
        ownerSet.add(piece.id);
        return piece;
    }
    findSpawnCenter() {
        const radius = SPAWN_BASE_RADIUS + SPAWN_RADIUS_PER_PLAYER * this.players.size;
        for (let attempt = 0; attempt < SPAWN_MAX_ATTEMPTS; attempt++) {
            const angle = Math.random() * Math.PI * 2;
            const r = Math.sqrt(Math.random()) * radius;
            const c = {
                x: Math.round(Math.cos(angle) * r),
                y: Math.round(Math.sin(angle) * r),
            };
            if (this.canFitSpawn(c))
                return c;
        }
        for (let r = 1; r < 200; r++) {
            for (let x = -r; x <= r; x++) {
                for (let y = -r; y <= r; y++) {
                    if (Math.max(Math.abs(x), Math.abs(y)) !== r)
                        continue;
                    if (this.canFitSpawn({ x, y }))
                        return { x, y };
                }
            }
        }
        return { x: 0, y: 0 };
    }
    canFitSpawn(center) {
        const cells = [
            center,
            { x: center.x + 1, y: center.y },
            { x: center.x - 1, y: center.y },
            { x: center.x, y: center.y + 1 },
            { x: center.x, y: center.y - 1 },
        ];
        for (const c of cells) {
            if (this.getPieceAt(c))
                return false;
            // Holes are impassable terrain — a fresh spawn must never overlap one.
            if (this.holes.has(this.posKey(c.x, c.y)))
                return false;
        }
        // Maintain a minimum Chebyshev separation between this spawn's pawns
        // and every existing pawn on the board so two fresh formations don't
        // land in immediate striking range. `addPlayer` calls this BEFORE the
        // player's own pieces exist, so every iterated pawn belongs to someone
        // else by construction.
        const pawnCells = cells.slice(1);
        for (const p of this.pieces.values()) {
            if (p.type !== 'pawn')
                continue;
            for (const c of pawnCells) {
                if (chebyshev(p.pos, c) < MIN_PAWN_SEPARATION)
                    return false;
            }
        }
        return true;
    }
}
/** True if a piece's current position OR either end of its telegraphed move lies in the rect. */
function pieceTouchesRect(piece, minX, maxX, minY, maxY) {
    const inRect = (c) => c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY;
    if (inRect(piece.pos))
        return true;
    if (piece.move) {
        if (inRect(piece.move.from) || inRect(piece.move.to))
            return true;
    }
    return false;
}
