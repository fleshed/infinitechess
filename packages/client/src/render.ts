import {
  BOMB_BLAST_RADIUS,
  BOMB_FUSE_MS,
  BOMB_PLACEMENT_ENEMY_RADIUS,
  BOMB_PLACEMENT_FRIEND_RADIUS,
  COLOR_BOMB,
  COLOR_CHOSEN_EMPTY,
  COLOR_CHOSEN_SELECTED,
  COLOR_DARK_TILE,
  COLOR_HOLE,
  COLOR_HOVER_EMPTY,
  COLOR_HOVER_SELECTED,
  COLOR_INVALID,
  COLOR_LIGHT_TILE,
  COLOR_RESOURCE_ACTIVE,
  COLOR_RESOURCE_IDLE,
  LEVEL_UP_THRESHOLDS_L2,
  PIECE_VALUE,
  TICK_MS,
  UPGRADE_COST_L2_MULT,
  UPGRADE_ELIGIBLE_TYPES_L2,
  chebyshev,
  coordEq,
  enumerateMoves,
} from '@infinitechess/shared';
import type { Coord, Occupant, Piece, PieceType } from '@infinitechess/shared';
import { Camera } from './camera.js';
import { GameState } from './state.js';

// Unicode chess glyphs — placeholder until proper vector assets ship.
const GLYPHS: Record<Piece['type'], string> = {
  king: '\u265A',
  queen: '\u265B',
  rook: '\u265C',
  bishop: '\u265D',
  knight: '\u265E',
  pawn: '\u265F',
};

export class Renderer {
  ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement, private state: GameState, private camera: Camera) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(window.innerWidth * dpr);
    this.canvas.height = Math.floor(window.innerHeight * dpr);
    this.canvas.style.width = `${window.innerWidth}px`;
    this.canvas.style.height = `${window.innerHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(now: number): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    this.drawBoard(w, h);
    this.drawResourceTiles(w, h);
    this.drawHoles(w, h);
    this.drawGoalMarkers(w, h);
    this.drawFormationLinks(w, h);
    this.drawSelectionHighlights(w, h);
    this.drawTelegraphs(w, h, now);
    this.drawPieces(w, h);
    this.drawBombs(w, h, now);
    this.drawDragPreview(w, h);
    this.drawPlacementGhost(w, h);
    this.drawSelectionBox();
    this.drawResourceLabels(w, h);
    this.drawHoverTooltip(w, h);
  }

  private drawBoard(w: number, h: number): void {
    const { minX, maxX, minY, maxY } = this.camera.visibleRange(w, h);
    const ts = this.camera.tileSize;
    const ctx = this.ctx;
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const screen = this.camera.worldToScreen({ x, y }, w, h);
        const light = ((x + y) & 1) === 0;
        ctx.fillStyle = light ? COLOR_LIGHT_TILE : COLOR_DARK_TILE;
        ctx.fillRect(screen.x - ts / 2, screen.y - ts / 2, ts, ts);
      }
    }
  }

  /** Paint a purple tile on every visible resource square. Active (a
   *  piece is on it) squares use the brighter shade; idle uses the dark
   *  shade. Drawn over the checker board, under everything else so
   *  selection highlights and pieces still render on top. */
  private drawResourceTiles(w: number, h: number): void {
    const ts = this.camera.tileSize;
    const ctx = this.ctx;
    for (const r of this.state.snapshot.resources ?? []) {
      const screen = this.camera.worldToScreen(r.pos, w, h);
      ctx.fillStyle = r.claimedBy ? COLOR_RESOURCE_ACTIVE : COLOR_RESOURCE_IDLE;
      ctx.fillRect(screen.x - ts / 2, screen.y - ts / 2, ts, ts);
      // Hidden squares get a thin dashed outline so the player can tell
      // them apart from public Visible ones — they exist only in their
      // private view.
      if (r.kind === 'hidden') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.strokeRect(screen.x - ts / 2 + 1, screen.y - ts / 2 + 1, ts - 2, ts - 2);
        ctx.setLineDash([]);
        ctx.restore();
      }
    }
  }

  /** Paint each Hole as a pitch-black tile with the regen countdown text
   *  centered inside. Drawn over resource tiles but UNDER pieces (pieces
   *  can never stand on a hole, so they'll never overlap; but the layer
   *  order keeps the visual hierarchy consistent: terrain < units). */
  private drawHoles(w: number, h: number): void {
    const holes = this.state.snapshot.holes;
    if (!holes || holes.length === 0) return;
    const ts = this.camera.tileSize;
    const ctx = this.ctx;
    const tickNow = this.state.currentTick(performance.now());
    ctx.save();
    for (const hole of holes) {
      const screen = this.camera.worldToScreen(hole.pos, w, h);
      ctx.fillStyle = COLOR_HOLE;
      ctx.fillRect(screen.x - ts / 2, screen.y - ts / 2, ts, ts);
      // Subtle border so a hole against a dark tile still reads as terrain
      // rather than an empty void.
      ctx.strokeStyle = '#374151';
      ctx.lineWidth = 1;
      ctx.strokeRect(screen.x - ts / 2 + 0.5, screen.y - ts / 2 + 0.5, ts - 1, ts - 1);
      if (ts >= 18) {
        const remainingMs = Math.max(0, (hole.regenEndTick - tickNow) * TICK_MS);
        const label = formatHoleRegen(remainingMs);
        ctx.font = `${Math.max(9, Math.floor(ts * 0.22))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#94a3b8';
        ctx.strokeText(label, screen.x, screen.y);
        ctx.fillText(label, screen.x, screen.y);
      }
    }
    ctx.restore();
  }

  /** Paint each live bomb as an amber filled circle with a 1-decimal
   *  countdown to detonation. Drawn AFTER pieces so the fuse number is
   *  always legible, since a bomb can be placed on the same square a
   *  piece will arrive at and we want both visible. */
  private drawBombs(w: number, h: number, now: number): void {
    const bombs = this.state.snapshot.bombs;
    if (!bombs || bombs.length === 0) return;
    const ts = this.camera.tileSize;
    const ctx = this.ctx;
    const tickNow = this.state.currentTick(now);
    ctx.save();
    for (const bomb of bombs) {
      const screen = this.camera.worldToScreen(bomb.pos, w, h);
      const remainingMs = Math.max(0, (bomb.fuseEndTick - tickNow) * TICK_MS);
      // Pulse intensity grows as the fuse approaches zero.
      const frac = Math.max(0, Math.min(1, 1 - remainingMs / BOMB_FUSE_MS));
      const pulse = 0.7 + 0.3 * Math.sin(now / 120);
      const radius = ts * (0.30 + 0.05 * frac);
      ctx.globalAlpha = 0.55 + 0.35 * frac * pulse;
      ctx.fillStyle = COLOR_BOMB;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#7c2d12';
      ctx.stroke();
      if (ts >= 18) {
        const seconds = remainingMs / 1000;
        const label = seconds < 10 ? seconds.toFixed(1) : Math.ceil(seconds).toString();
        ctx.font = `bold ${Math.max(10, Math.floor(ts * 0.32))}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#000';
        ctx.fillStyle = '#fff7ed';
        ctx.strokeText(label, screen.x, screen.y);
        ctx.fillText(label, screen.x, screen.y);
      }
    }
    ctx.restore();
  }

  /** "X/Y C/s" overlay drawn AFTER pieces so the yield label is always
   *  legible. X = current production (0 if unclaimed, else yield), Y =
   *  max. Skipped when the tile is too small to read. */
  private drawResourceLabels(w: number, h: number): void {
    const ts = this.camera.tileSize;
    if (ts < 20) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${Math.max(9, Math.floor(ts * 0.20))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    ctx.fillStyle = '#fde68a'; // amber-200 for contrast vs purple
    for (const r of this.state.snapshot.resources ?? []) {
      const screen = this.camera.worldToScreen(r.pos, w, h);
      const current = r.claimedBy ? r.yield : 0;
      const label = `${current}/${r.yield} C/s`;
      const ty = screen.y + ts / 2 - 2;
      ctx.strokeText(label, screen.x, ty);
      ctx.fillText(label, screen.x, ty);
    }
    ctx.restore();
  }

  /** Faint dot at the goal of each of our pieces, plus a line back to the piece. */
  private drawGoalMarkers(w: number, h: number): void {
    const ctx = this.ctx;
    for (const piece of this.state.snapshot.pieces) {
      if (piece.ownerId !== this.state.playerId || !piece.goal) continue;
      const piecePt = this.camera.worldToScreen(piece.pos, w, h);
      const goalPt = this.camera.worldToScreen(piece.goal, w, h);
      const color = this.ownerColor(piece.ownerId);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.strokeStyle = color;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(piecePt.x, piecePt.y);
      ctx.lineTo(goalPt.x, goalPt.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(goalPt.x, goalPt.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawSelectionHighlights(w: number, h: number): void {
    const hasSelection = this.state.selectedPieceIds.size > 0;
    const hover = this.state.hoverSquare;

    // Outline every selected piece.
    for (const id of this.state.selectedPieceIds) {
      const p = this.state.getPieceById(id);
      if (p) this.outlineSquare(p.pos, COLOR_CHOSEN_SELECTED, w, h, 3);
    }

    if (!hover) return;
    const hoveredPiece = this.state.getPieceAt(hover);
    const hoveringSelectedOwn =
      hoveredPiece &&
      hoveredPiece.ownerId === this.state.playerId &&
      this.state.selectedPieceIds.has(hoveredPiece.id);

    let color: string;
    if (hasSelection) {
      if (hoveringSelectedOwn) color = COLOR_CHOSEN_SELECTED;
      else if (hoveredPiece && hoveredPiece.ownerId === this.state.playerId)
        color = COLOR_CHOSEN_EMPTY; // hovering another own piece — click would select / shift-click toggles
      else color = COLOR_HOVER_SELECTED;
    } else {
      color = hoveredPiece && hoveredPiece.ownerId === this.state.playerId
        ? COLOR_CHOSEN_EMPTY
        : COLOR_HOVER_EMPTY;
    }
    // Red flash: hovering an enemy with no selection — can't target anything.
    if (!hasSelection && hoveredPiece && hoveredPiece.ownerId !== this.state.playerId) {
      color = COLOR_INVALID;
    }
    this.outlineSquare(hover, color, w, h, 2);
  }

  private drawTelegraphs(w: number, h: number, now: number): void {
    const ctx = this.ctx;
    const tickNow = this.state.currentTick(now);
    for (const piece of this.state.snapshot.pieces) {
      if (!piece.move) continue;
      const m = piece.move;
      const total = m.endTick - m.startTick;
      const remaining = Math.max(0, m.endTick - tickNow);
      const progress = Math.min(1, Math.max(0, 1 - remaining / total));

      const from = this.camera.worldToScreen(m.from, w, h);
      const to = this.camera.worldToScreen(m.to, w, h);
      const ix = from.x + (to.x - from.x) * progress;
      const iy = from.y + (to.y - from.y) * progress;

      ctx.save();
      ctx.lineWidth = 3;
      ctx.strokeStyle = this.ownerColor(piece.ownerId) + 'cc';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();

      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const headLen = 10;
      ctx.beginPath();
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6),
                 to.y - headLen * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6),
                 to.y - headLen * Math.sin(angle + Math.PI / 6));
      ctx.stroke();

      const seconds = (remaining * this.state.tickMs) / 1000;
      ctx.fillStyle = '#000';
      ctx.font = 'bold 12px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(seconds.toFixed(1) + 's', to.x, to.y - 8);
      ctx.restore();

      this.drawGlyph(piece, ix, iy, 0.4);
    }
  }

  private drawPieces(w: number, h: number): void {
    const tickNow = this.state.currentTick(performance.now());
    const myCurrency = this.state.snapshot.players.find((p) => p.id === this.state.playerId)?.currency ?? 0;
    for (const piece of this.state.snapshot.pieces) {
      const screen = this.camera.worldToScreen(piece.pos, w, h);
      const frozen = piece.frozenUntilTick !== undefined && piece.frozenUntilTick > tickNow;
      const locked = piece.lockedUntilTick !== undefined && piece.lockedUntilTick > tickNow;
      this.drawGlyph(piece, screen.x, screen.y, frozen || locked ? 0.45 : 1);
      if (frozen) this.drawFrozenMark(screen.x, screen.y);
      if (locked) this.drawLockedMark(screen.x, screen.y);
      // L2 badge (level indicator) — top-left corner.
      if (piece.level >= 2) this.drawLevelBadge(screen.x, screen.y, piece.level);
      // Upgrade-ready arrow — only on our own pieces meeting all upgrade
      // conditions including affordability. Bottom-right corner so it
      // doesn't collide with the L2 badge.
      if (
        piece.ownerId === this.state.playerId &&
        piece.level < 2 &&
        (UPGRADE_ELIGIBLE_TYPES_L2 as readonly PieceType[]).includes(piece.type) &&
        this.meetsUpgradeThreshold(piece, tickNow) &&
        myCurrency >= PIECE_VALUE[piece.type] * UPGRADE_COST_L2_MULT
      ) {
        this.drawUpgradeReadyMark(screen.x, screen.y);
      }
    }
  }

  private meetsUpgradeThreshold(piece: Piece, currentTick: number): boolean {
    const age = currentTick - piece.bornTick;
    return (
      age >= LEVEL_UP_THRESHOLDS_L2.ageTicks ||
      (piece.kills ?? 0) >= LEVEL_UP_THRESHOLDS_L2.kills ||
      (piece.profit ?? 0) >= LEVEL_UP_THRESHOLDS_L2.profit
    );
  }

  private drawLevelBadge(x: number, y: number, level: number): void {
    const ctx = this.ctx;
    const ts = this.camera.tileSize;
    ctx.save();
    ctx.font = `bold ${Math.floor(ts * 0.28)}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    const label = level >= 3 ? 'III' : 'II';
    const bx = x - ts * 0.45;
    const by = y - ts * 0.45;
    ctx.strokeText(label, bx, by);
    ctx.fillStyle = '#fbbf24'; // amber-400
    ctx.fillText(label, bx, by);
    ctx.restore();
  }

  private drawUpgradeReadyMark(x: number, y: number): void {
    const ctx = this.ctx;
    const ts = this.camera.tileSize;
    ctx.save();
    ctx.font = `bold ${Math.floor(ts * 0.32)}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#000';
    const bx = x + ts * 0.45;
    const by = y + ts * 0.45;
    ctx.strokeText('\u2191', bx, by);
    ctx.fillStyle = '#4ade80'; // green-400
    ctx.fillText('\u2191', bx, by);
    ctx.restore();
  }

  /** Floating panel near the cursor showing the hovered piece's stats.
   *  Renders for any piece (own or enemy) since the spec wants stats
   *  visible regardless of ownership; upgrade hints are added only for
   *  pieces the local player owns. */
  private drawHoverTooltip(w: number, h: number): void {
    if (!this.state.hoverSquare) return;
    const piece = this.state.getPieceAt(this.state.hoverSquare);
    if (!piece) return;
    // Suppress while drag-selecting or placement-armed to avoid overlap.
    if (this.state.selectionBox || this.state.placement || this.state.contextMenu) return;
    const screen = this.camera.worldToScreen(piece.pos, w, h);
    const tickNow = this.state.currentTick(performance.now());
    const ageS = Math.max(0, Math.round(((tickNow - piece.bornTick) * TICK_MS) / 1000));
    const isMine = piece.ownerId === this.state.playerId;
    const lines: string[] = [
      `${piece.type} \u00B7 lvl ${piece.level}${isMine ? '' : '  (enemy)'}`,
      `age ${ageS}s \u00B7 kills ${piece.kills ?? 0} \u00B7 \u00A4${Math.floor(piece.profit ?? 0)}`,
    ];
    if (isMine && piece.level < 2) {
      if (!(UPGRADE_ELIGIBLE_TYPES_L2 as readonly PieceType[]).includes(piece.type)) {
        lines.push('L2 ability pending');
      } else if (this.meetsUpgradeThreshold(piece, tickNow)) {
        const cost = PIECE_VALUE[piece.type] * UPGRADE_COST_L2_MULT;
        lines.push(`ready to upgrade \u2014 \u00A4${cost}`);
      } else {
        lines.push('not yet eligible for L2');
      }
    }
    const ctx = this.ctx;
    const ts = this.camera.tileSize;
    ctx.save();
    ctx.font = `${Math.max(11, Math.floor(ts * 0.22))}px sans-serif`;
    const padX = 8, padY = 6, lineH = Math.max(13, Math.floor(ts * 0.24));
    let maxW = 0;
    for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
    const boxW = maxW + padX * 2;
    const boxH = padY * 2 + lineH * lines.length;
    // Position to the upper-right of the piece, clamped to viewport.
    let bx = screen.x + ts * 0.55;
    let by = screen.y - ts * 0.6 - boxH;
    if (bx + boxW > w - 4) bx = screen.x - ts * 0.55 - boxW;
    if (by < 4) by = screen.y + ts * 0.6;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.lineWidth = 1;
    ctx.fillRect(bx, by, boxW, boxH);
    ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i]!, bx + padX, by + padY + i * lineH);
    }
    ctx.restore();
  }

  private drawLockedMark(x: number, y: number): void {
    const ctx = this.ctx;
    const r = this.camera.tileSize * 0.42;
    ctx.save();
    ctx.strokeStyle = '#facc15';
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = `bold ${Math.floor(this.camera.tileSize * 0.42)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#facc15';
    ctx.fillText('\u{1F512}', x + this.camera.tileSize * 0.32, y + this.camera.tileSize * 0.32);
    ctx.restore();
  }

  /** Thin dashed gold lines connecting every pair of pieces in the same auto-formation. */
  private drawFormationLinks(w: number, h: number): void {
    const ctx = this.ctx;
    // Group pieces by formationId (only our own).
    const groups = new Map<string, typeof this.state.snapshot.pieces>();
    for (const piece of this.state.snapshot.pieces) {
      if (piece.ownerId !== this.state.playerId) continue;
      if (!piece.formationId) continue;
      const list = groups.get(piece.formationId) ?? [];
      list.push(piece);
      groups.set(piece.formationId, list);
    }
    if (groups.size === 0) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) {
        const a = list[i]!;
        const from = this.camera.worldToScreen(a.pos, w, h);
        for (let j = i + 1; j < list.length; j++) {
          const b = list[j]!;
          const to = this.camera.worldToScreen(b.pos, w, h);
          ctx.beginPath();
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  private drawFrozenMark(x: number, y: number): void {
    const ctx = this.ctx;
    const r = this.camera.tileSize * 0.42;
    ctx.save();
    ctx.strokeStyle = '#bfdbfe';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.font = `bold ${Math.floor(this.camera.tileSize * 0.45)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#bfdbfe';
    ctx.fillText('\u2744', x + this.camera.tileSize * 0.32, y - this.camera.tileSize * 0.32);
    ctx.restore();
  }

  private drawDragPreview(w: number, h: number): void {
    const drag = this.state.drag;
    if (!drag || !drag.hasMoved) return;
    const piece = this.state.getPieceById(drag.pieceId);
    if (!piece) return;

    const ctx = this.ctx;
    const color = this.ownerColor(piece.ownerId);
    const start = this.camera.worldToScreen(piece.pos, w, h);

    ctx.save();
    // Line from piece to cursor
    ctx.strokeStyle = color + 'cc';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(drag.currentScreen.x, drag.currentScreen.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Outline the candidate destination square
    this.outlineSquare(drag.currentSquare, color, w, h, 2);

    // Ghost of the dragged piece following the cursor
    this.drawGlyph(piece, drag.currentScreen.x, drag.currentScreen.y, 0.6);
  }

  private drawSelectionBox(): void {
    const box = this.state.selectionBox;
    if (!box || !box.hasMoved) return;
    const ctx = this.ctx;
    const x = Math.min(box.startScreen.x, box.currentScreen.x);
    const y = Math.min(box.startScreen.y, box.currentScreen.y);
    const bw = Math.abs(box.currentScreen.x - box.startScreen.x);
    const bh = Math.abs(box.currentScreen.y - box.startScreen.y);
    ctx.save();
    ctx.fillStyle = 'rgba(31, 58, 138, 0.18)';
    ctx.fillRect(x, y, bw, bh);
    ctx.strokeStyle = '#bfdbfe';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x + 0.5, y + 0.5, bw, bh);
    ctx.restore();
  }

  /** Ghost preview while shop-placement mode is armed: shows where the new
   *  piece would land at the hovered square. Tinted with the player's own
   *  color if the placement is plausibly valid (empty + adjacent to one of
   *  our pieces AND wouldn't auto-check an enemy king), red otherwise.
   *  Server is still authoritative on click. */
  private drawPlacementGhost(w: number, h: number): void {
    const placement = this.state.placement;
    const hover = this.state.hoverSquare;
    if (!placement || !hover) return;

    if (placement.kind === 'bomb') {
      this.drawBombPlacementGhost(hover, w, h);
      return;
    }

    const occupied = this.state.getPieceAt(hover) !== undefined;
    let adjacent = false;
    for (const p of this.state.snapshot.pieces) {
      if (p.ownerId !== this.state.playerId) continue;
      if (chebyshev(p.pos, hover) <= 1) { adjacent = true; break; }
    }
    // Reserved by an in-flight telegraph?
    let reserved = false;
    for (const p of this.state.snapshot.pieces) {
      if (p.move && coordEq(p.move.to, hover)) { reserved = true; break; }
    }
    // Would the new piece immediately threaten an enemy king? Mirror the
    // server-side rule so the player sees the rejection before clicking.
    // Best-effort: only checks against pieces currently in the viewport
    // snapshot — far-off kings outside the stream would still be rejected
    // by the server. enumerateMoves needs the same occupancy lookup style.
    const occFn = (c: Coord): Occupant => {
      // Holes in the local snapshot also count as blocked, matching server.
      for (const hole of this.state.snapshot.holes ?? []) {
        if (coordEq(hole.pos, c)) return 'blocked';
      }
      for (const p of this.state.snapshot.pieces) {
        if (!coordEq(p.pos, c)) continue;
        return p.ownerId === this.state.playerId ? 'friendly' : 'enemy';
      }
      return 'empty';
    };
    let wouldCheckKing = false;
    if (!occupied && !reserved) {
      const reach = enumerateMoves(placement.type, 1, hover, occFn);
      for (const p of this.state.snapshot.pieces) {
        if (p.type !== 'king' || p.ownerId === this.state.playerId) continue;
        if (reach.some((c) => coordEq(c, p.pos))) { wouldCheckKing = true; break; }
      }
    }
    const valid = !occupied && !reserved && adjacent && !wouldCheckKing;
    const color = valid ? this.ownerColor(this.state.playerId ?? '') : COLOR_INVALID;

    const screen = this.camera.worldToScreen(hover, w, h);
    this.outlineSquare(hover, color, w, h, 2);

    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.font = `bold ${Math.floor(this.camera.tileSize * 0.8)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.strokeText(GLYPHS[placement.type as PieceType], screen.x, screen.y);
    ctx.fillStyle = color;
    ctx.fillText(GLYPHS[placement.type as PieceType], screen.x, screen.y);
    // Reason marker: tiny "!K" label next to a red ghost rejected for
    // would-check-king, so the player understands why this square is bad.
    if (wouldCheckKing) {
      ctx.globalAlpha = 0.95;
      ctx.font = `bold ${Math.floor(this.camera.tileSize * 0.32)}px system-ui`;
      ctx.fillStyle = '#fecaca';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tx = screen.x + this.camera.tileSize * 0.18;
      const ty = screen.y - this.camera.tileSize * 0.48;
      ctx.strokeText('!K', tx, ty);
      ctx.fillText('!K', tx, ty);
    }
    ctx.restore();
  }

  /** Bomb ghost: shows the 3x3 blast footprint and validates server rules
   *  (placement square clear, friendly support within R, no enemy within R).
   *  Amber = valid, red = rejected. Server is still authoritative on click. */
  private drawBombPlacementGhost(hover: Coord, w: number, h: number): void {
    const ts = this.camera.tileSize;
    const ctx = this.ctx;
    let friendlyClose = false;
    let enemyTooClose = false;
    const occupied = this.state.getPieceAt(hover) !== undefined;
    let onHole = false;
    for (const hole of this.state.snapshot.holes ?? []) {
      if (coordEq(hole.pos, hover)) { onHole = true; break; }
    }
    let onBomb = false;
    for (const b of this.state.snapshot.bombs ?? []) {
      if (coordEq(b.pos, hover)) { onBomb = true; break; }
    }
    for (const p of this.state.snapshot.pieces) {
      const d = chebyshev(p.pos, hover);
      if (p.ownerId === this.state.playerId) {
        if (d <= BOMB_PLACEMENT_FRIEND_RADIUS) friendlyClose = true;
      } else if (d < BOMB_PLACEMENT_ENEMY_RADIUS) {
        enemyTooClose = true;
      }
    }
    const valid = !occupied && !onHole && !onBomb && friendlyClose && !enemyTooClose;
    const color = valid ? COLOR_BOMB : COLOR_INVALID;

    // Paint the 3x3 blast footprint as a translucent overlay so the
    // player can see which squares (and which pieces) would be destroyed.
    ctx.save();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = color;
    for (let dx = -BOMB_BLAST_RADIUS; dx <= BOMB_BLAST_RADIUS; dx++) {
      for (let dy = -BOMB_BLAST_RADIUS; dy <= BOMB_BLAST_RADIUS; dy++) {
        const sc = this.camera.worldToScreen({ x: hover.x + dx, y: hover.y + dy }, w, h);
        ctx.fillRect(sc.x - ts / 2, sc.y - ts / 2, ts, ts);
      }
    }
    ctx.restore();
    this.outlineSquare(hover, color, w, h, 3);

    // Centered bomb glyph at hover.
    const screen = this.camera.worldToScreen(hover, w, h);
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.font = `${Math.floor(ts * 0.7)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\uD83D\uDCA3', screen.x, screen.y);
    ctx.restore();

    // Reason label when rejected.
    if (!valid) {
      const reason = enemyTooClose
        ? `enemy < ${BOMB_PLACEMENT_ENEMY_RADIUS}sq`
        : !friendlyClose
        ? `need friend \u2264 ${BOMB_PLACEMENT_FRIEND_RADIUS}sq`
        : onHole
        ? 'hole'
        : onBomb
        ? 'bomb here'
        : 'occupied';
      ctx.save();
      ctx.font = `bold ${Math.floor(ts * 0.28)}px system-ui`;
      ctx.fillStyle = '#fecaca';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 3;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const tx = screen.x + ts * 0.18;
      const ty = screen.y - ts * 0.48;
      ctx.strokeText(reason, tx, ty);
      ctx.fillText(reason, tx, ty);
      ctx.restore();
    }
  }

  private drawGlyph(piece: Piece, x: number, y: number, alpha: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `bold ${Math.floor(this.camera.tileSize * 0.8)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#000';
    ctx.strokeText(GLYPHS[piece.type], x, y);
    ctx.fillStyle = this.ownerColor(piece.ownerId);
    ctx.fillText(GLYPHS[piece.type], x, y);
    ctx.restore();
  }

  private outlineSquare(c: Coord, color: string, w: number, h: number, lineWidth: number): void {
    const ts = this.camera.tileSize;
    const screen = this.camera.worldToScreen(c, w, h);
    const ctx = this.ctx;
    ctx.save();
    ctx.lineWidth = lineWidth;
    ctx.strokeStyle = color;
    ctx.strokeRect(
      screen.x - ts / 2 + lineWidth / 2,
      screen.y - ts / 2 + lineWidth / 2,
      ts - lineWidth,
      ts - lineWidth,
    );
    ctx.restore();
  }

  private ownerColor(playerId: string): string {
    return this.state.snapshot.players.find((p) => p.id === playerId)?.color ?? '#fff';
  }
}

/** Format hole regen time. Above 60s show "Mm Ss"; under 60s show "Xs"
 *  so a player can read the countdown without doing the math. */
function formatHoleRegen(ms: number): string {
  if (ms <= 0) return '0s';
  const totalSeconds = Math.ceil(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}
