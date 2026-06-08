import type { Coord, Piece, PieceType, PlayerId, WorldSnapshot } from '@infinitechess/shared';

/**
 * Latest known world state plus the local timing baseline used to interpolate
 * telegraph countdowns smoothly between server snapshots.
 */
export class GameState {
  playerId: PlayerId | null = null;
  tickMs = 100;
  snapshot: WorldSnapshot = { tick: 0, players: [], pieces: [], resources: [], bombs: [], holes: [] };
  /** performance.now() when the last snapshot arrived. */
  snapshotReceivedAt = 0;

  // UI selection state. A set so SHIFT-click can highlight multiple pieces and
  // dispatch the same goal to all of them in one gesture.
  selectedPieceIds: Set<string> = new Set();
  hoverSquare: Coord | null = null;

  /** Active click-and-drag of one of our own pieces (null when not dragging). */
  drag: {
    pieceId: string;
    startSquare: Coord;
    startScreen: { x: number; y: number };
    currentScreen: { x: number; y: number };
    currentSquare: Coord;
    hasMoved: boolean;
  } | null = null;

  /**
   * Active SHIFT-drag rubber-band selection box, in screen-space coordinates.
   * On release every own piece intersecting the box is added to `selectedPieceIds`.
   */
  selectionBox: {
    startScreen: { x: number; y: number };
    currentScreen: { x: number; y: number };
    hasMoved: boolean;
  } | null = null;

  /** Open right-click context menu (DOM-rendered) for a single piece. */
  contextMenu: { pieceId: string; screen: { x: number; y: number } } | null = null;

  /** Shop placement mode: armed type follows the cursor as a ghost; next
   *  left-click on the canvas sends a buyPiece for that square. ESC or
   *  right-click exits without spending currency. A bomb placement is a
   *  distinct kind because it uses a different ghost and a different
   *  network message; bomb has no piece type. */
  placement: { kind: 'piece'; type: PieceType } | { kind: 'bomb' } | null = null;

  setSnapshot(snap: WorldSnapshot): void {
    this.snapshot = snap;
    this.snapshotReceivedAt = performance.now();
    // Prune any selected pieces that no longer exist (captured / despawned).
    if (this.selectedPieceIds.size > 0) {
      const alive = new Set(snap.pieces.map((p) => p.id));
      for (const id of [...this.selectedPieceIds]) {
        if (!alive.has(id)) this.selectedPieceIds.delete(id);
      }
    }
  }

  isSelected(id: string): boolean {
    return this.selectedPieceIds.has(id);
  }

  /** Estimated current server tick, interpolated since the last snapshot. */
  currentTick(now: number): number {
    const elapsed = now - this.snapshotReceivedAt;
    return this.snapshot.tick + elapsed / this.tickMs;
  }

  getPieceAt(c: Coord): Piece | undefined {
    return this.snapshot.pieces.find((p) => p.pos.x === c.x && p.pos.y === c.y);
  }

  getPieceById(id: string): Piece | undefined {
    return this.snapshot.pieces.find((p) => p.id === id);
  }

  myPieces(): Piece[] {
    return this.snapshot.pieces.filter((p) => p.ownerId === this.playerId);
  }
}
