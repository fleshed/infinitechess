import type { Coord } from '@infinitechess/shared';
import { ZOOM_STEP } from '@infinitechess/shared';
import { Camera } from './camera.js';
import { Net } from './net.js';
import { GameState } from './state.js';

/** Pixels of cursor movement past which a press is treated as a drag, not a click. */
const DRAG_THRESHOLD_PX = 4;

export class Input {
  private heldKeys = new Set<string>();
  private lastPanFrame = performance.now();

  /** What was under the cursor when the current mouse button went down. */
  private downSquare: Coord | null = null;
  private downOnOwnPiece = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private state: GameState,
    private camera: Camera,
    private net: Net,
  ) {
    canvas.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mousedown', this.onMouseDown);
    canvas.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('mouseleave', this.cancelDrag);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', (e) => {
      this.heldKeys.add(e.key.toLowerCase());
      if (e.key === 'Escape') {
        this.state.contextMenu = null;
        this.state.placement = null;
      }
    });
    window.addEventListener('keyup', (e) => this.heldKeys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.heldKeys.clear());
  }

  /** Continuous WASD/arrow-key panning, driven from the animation frame. */
  updatePan(now: number): void {
    const dt = (now - this.lastPanFrame) / 1000;
    this.lastPanFrame = now;
    const speed = 10;
    let dx = 0;
    let dy = 0;
    if (this.heldKeys.has('w') || this.heldKeys.has('arrowup')) dy -= 1;
    if (this.heldKeys.has('s') || this.heldKeys.has('arrowdown')) dy += 1;
    if (this.heldKeys.has('a') || this.heldKeys.has('arrowleft')) dx -= 1;
    if (this.heldKeys.has('d') || this.heldKeys.has('arrowright')) dx += 1;
    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      this.camera.centerX += (dx / len) * speed * dt;
      this.camera.centerY += (dy / len) * speed * dt;
    }
  }

  private screenFromEvent(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private squareFromScreen(s: { x: number; y: number }): Coord {
    return this.camera.screenToWorldSquare(s.x, s.y, this.canvas.width, this.canvas.height);
  }

  private onMouseMove = (e: MouseEvent): void => {
    const screen = this.screenFromEvent(e);
    this.state.hoverSquare = this.squareFromScreen(screen);

    const drag = this.state.drag;
    if (drag) {
      drag.currentScreen = screen;
      drag.currentSquare = this.state.hoverSquare;
      if (
        Math.hypot(
          screen.x - drag.startScreen.x,
          screen.y - drag.startScreen.y,
        ) > DRAG_THRESHOLD_PX
      ) {
        drag.hasMoved = true;
      }
    }

    const box = this.state.selectionBox;
    if (box) {
      box.currentScreen = screen;
      if (
        Math.hypot(
          screen.x - box.startScreen.x,
          screen.y - box.startScreen.y,
        ) > DRAG_THRESHOLD_PX
      ) {
        box.hasMoved = true;
      }
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    const screen = this.screenFromEvent(e);
    const sq = this.squareFromScreen(screen);

    // Placement mode (shop): left-click places, right-click cancels.
    // Always preempt the regular selection/drag flow so a stray click can't
    // also start a piece-drag or wipe the selection underneath the ghost.
    if (this.state.placement) {
      if (e.button === 0) {
        const placement = this.state.placement;
        if (placement.kind === 'piece') {
          this.net.sendBuyPiece(placement.type, sq);
        } else {
          this.net.sendPlaceBomb(sq);
        }
        // Stay in placement mode so the player can buy a row of pieces.
        // ESC or right-click exits.
      } else if (e.button === 2) {
        this.state.placement = null;
      }
      return;
    }

    if (e.button === 2) {
      // Right-click: open the context menu on a friendly piece OR clear the selection.
      const piece = this.state.getPieceAt(sq);
      if (piece && piece.ownerId === this.state.playerId) {
        this.state.contextMenu = { pieceId: piece.id, screen: { x: e.clientX, y: e.clientY } };
      } else {
        this.state.contextMenu = null;
        this.cancelDrag();
        this.state.selectedPieceIds.clear();
      }
      return;
    }
    if (e.button !== 0) return;

    // Any left-click closes the context menu.
    this.state.contextMenu = null;

    this.downSquare = sq;
    const piece = this.state.getPieceAt(sq);
    this.downOnOwnPiece = !!piece && piece.ownerId === this.state.playerId;

    // SHIFT-down on empty/enemy: begin rubber-band selection.
    // SHIFT-down on own piece: defer to mouseUp toggle, don't start a piece drag.
    if (e.shiftKey) {
      if (!this.downOnOwnPiece) {
        this.state.selectionBox = {
          startScreen: screen,
          currentScreen: screen,
          hasMoved: false,
        };
      }
      return;
    }

    if (this.downOnOwnPiece && piece) {
      // Start a potential drag; promoted to a real one once the cursor moves enough.
      this.state.drag = {
        pieceId: piece.id,
        startSquare: sq,
        startScreen: screen,
        currentScreen: screen,
        currentSquare: sq,
        hasMoved: false,
      };
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button !== 0) return;
    const screen = this.screenFromEvent(e);
    const upSquare = this.squareFromScreen(screen);
    const drag = this.state.drag;
    const box = this.state.selectionBox;
    const shift = e.shiftKey;

    if (box) {
      if (box.hasMoved) {
        // Add every own piece whose square falls inside the box to the selection.
        const a = this.squareFromScreen(box.startScreen);
        const b = this.squareFromScreen(box.currentScreen);
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        for (const p of this.state.myPieces()) {
          if (p.pos.x >= minX && p.pos.x <= maxX && p.pos.y >= minY && p.pos.y <= maxY) {
            this.state.selectedPieceIds.add(p.id);
          }
        }
      }
      this.state.selectionBox = null;
      this.state.drag = null;
      this.downSquare = null;
      this.downOnOwnPiece = false;
      return;
    }

    if (drag && drag.hasMoved) {
      // True drag: the dragged piece (plus its current group) marches to
      // upSquare. The "group" is, in order of precedence:
      //   1) manual selection that already contains the dragged piece
      //   2) the dragged piece's whole formation (auto), unless CTRL is held
      //   3) just the dragged piece (solo)
      if (!sameSquare(drag.startSquare, upSquare)) {
        const draggedPiece = this.state.getPieceById(drag.pieceId);
        let groupIds: string[];
        if (
          this.state.selectedPieceIds.size > 1 &&
          this.state.selectedPieceIds.has(drag.pieceId)
        ) {
          groupIds = [...this.state.selectedPieceIds];
        } else if (e.ctrlKey || !draggedPiece || !draggedPiece.formationId) {
          groupIds = [drag.pieceId];
        } else {
          groupIds = [drag.pieceId];
          for (const p of this.state.snapshot.pieces) {
            if (
              p.ownerId === this.state.playerId &&
              p.formationId === draggedPiece.formationId &&
              p.id !== drag.pieceId
            ) {
              groupIds.push(p.id);
            }
          }
        }
        if (groupIds.length === 1) {
          this.net.sendMoveIntent(groupIds[0]!, upSquare);
        } else {
          this.net.sendFormationMove(groupIds, upSquare);
        }
        // Sticky selection = the group that just moved.
        this.state.selectedPieceIds = new Set(groupIds);
      }
      // Drop on same square is a no-op; the click branch below handles selection.
    } else if (this.downOnOwnPiece && this.downSquare && sameSquare(this.downSquare, upSquare)) {
      const piece = this.state.getPieceAt(upSquare);
      if (piece) {
        if (shift) {
          // SHIFT-click: toggle in/out of a manual multi-selection.
          if (this.state.selectedPieceIds.has(piece.id)) {
            this.state.selectedPieceIds.delete(piece.id);
          } else {
            this.state.selectedPieceIds.add(piece.id);
          }
        } else if (e.ctrlKey) {
          // CTRL-click: pick just this one piece, ignoring its formation.
          this.state.selectedPieceIds.clear();
          this.state.selectedPieceIds.add(piece.id);
        } else {
          // Plain click: select the entire formation this piece belongs to.
          this.state.selectedPieceIds.clear();
          this.state.selectedPieceIds.add(piece.id);
          if (piece.formationId) {
            for (const p of this.state.snapshot.pieces) {
              if (
                p.ownerId === this.state.playerId &&
                p.formationId === piece.formationId
              ) {
                this.state.selectedPieceIds.add(p.id);
              }
            }
          }
        }
      }
    } else if (this.state.selectedPieceIds.size > 0) {
      // Click on enemy/empty square with one or more pieces selected. Single
      // piece = direct moveIntent; multi = formation march (server picks the
      // anchor and translates each member by the same delta). Selection stays
      // sticky so the group can be re-directed without a fresh marquee.
      const ids = [...this.state.selectedPieceIds];
      if (ids.length === 1) {
        this.net.sendMoveIntent(ids[0]!, upSquare);
      } else {
        this.net.sendFormationMove(ids, upSquare);
      }
    }

    this.state.drag = null;
    this.downSquare = null;
    this.downOnOwnPiece = false;
  };

  private cancelDrag = (): void => {
    this.state.drag = null;
    this.state.selectionBox = null;
    this.downSquare = null;
    this.downOnOwnPiece = false;
  };

  /** Scroll-wheel zoom — anchored on the cursor so the world point under
   *  the pointer stays put. One notch = one ZOOM_STEP multiplier; trackpads
   *  fire many small notches per scroll, which is fine because Camera.zoomBy
   *  clamps to the global tile-size bounds. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const screen = this.screenFromEvent(e);
    const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
    this.camera.zoomBy(factor, screen.x, screen.y, this.canvas.width, this.canvas.height);
  };
}

function sameSquare(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}
