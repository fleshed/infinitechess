import { Camera } from './camera.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Renderer } from './render.js';
import { GameState } from './state.js';
import {
  BOMB_COST,
  BUYABLE_TYPES,
  LEVEL_UP_THRESHOLDS_L2,
  PIECE_VALUE,
  TICK_MS,
  UPGRADE_COST_L2_MULT,
  UPGRADE_ELIGIBLE_TYPES_L2,
} from '@infinitechess/shared';
import type { Piece, PieceType } from '@infinitechess/shared';

const canvas = document.getElementById('board') as HTMLCanvasElement;
const status = document.getElementById('hud-status') as HTMLDivElement;
const currencyEl = document.getElementById('hud-currency') as HTMLDivElement;
const coordsHover = document.getElementById('coords-hover') as HTMLElement;
const coordsView = document.getElementById('coords-view') as HTMLElement;
const ctxMenuEl = document.getElementById('ctxmenu') as HTMLDivElement;
const shopEl = document.getElementById('shop') as HTMLDivElement;

const state = new GameState();
const camera = new Camera();
const renderer = new Renderer(canvas, state, camera);

const net = new Net(
  state,
  (msg) => { status.textContent = msg; },
  () => {
    const mine = state.myPieces();
    const king = mine.find((p) => p.type === 'king') ?? mine[0];
    if (king) {
      camera.centerX = king.pos.x;
      camera.centerY = king.pos.y;
    }
  },
);

const input = new Input(canvas, state, camera, net);

/** Render the right-click menu when state.contextMenu is set. Only rebuilds
 *  the DOM when the menu identity changes — rebuilding every frame would
 *  replace the buttons between mousedown and mouseup, swallowing the click. */
let lastMenuKey = '';
function renderContextMenu(): void {
  const ctx = state.contextMenu;
  if (!ctx) {
    if (lastMenuKey !== '') {
      ctxMenuEl.style.display = 'none';
      ctxMenuEl.innerHTML = '';
      lastMenuKey = '';
    }
    return;
  }
  const piece = state.getPieceById(ctx.pieceId);
  if (!piece || piece.ownerId !== state.playerId) {
    state.contextMenu = null;
    ctxMenuEl.style.display = 'none';
    ctxMenuEl.innerHTML = '';
    lastMenuKey = '';
    return;
  }
  // Identity = which piece + which position on screen + which mode/state details that affect labels.
  const key = `${piece.id}|${ctx.screen.x}|${ctx.screen.y}|${piece.goal ? 1 : 0}|${piece.type}|${piece.level}|${piece.formationId ?? '-'}|${state.selectedPieceIds.size}`;
  if (key === lastMenuKey) return;
  lastMenuKey = key;

  ctxMenuEl.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = `${piece.type} \u00B7 lvl ${piece.level}`;
  ctxMenuEl.appendChild(label);

  // Per-piece stats (M5 leveling).
  const tickNow = state.currentTick(performance.now());
  const ageS = Math.max(0, Math.round(((tickNow - piece.bornTick) * TICK_MS) / 1000));
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.style.cssText = 'font-size:11px;color:#cbd5e1;padding:2px 6px';
  stats.textContent = `age ${ageS}s \u00B7 kills ${piece.kills ?? 0} \u00B7 profit \u00A4${Math.floor(piece.profit ?? 0)}`;
  ctxMenuEl.appendChild(stats);

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel current goal';
  cancelBtn.disabled = !piece.goal;
  cancelBtn.onclick = () => {
    net.sendCancelGoal(piece.id);
    state.contextMenu = null;
  };
  ctxMenuEl.appendChild(cancelBtn);

  const leaveBtn = document.createElement('button');
  leaveBtn.textContent = piece.formationId ? 'Leave formation' : 'Leave formation (not in one)';
  leaveBtn.disabled = !piece.formationId;
  leaveBtn.onclick = () => {
    net.sendLeaveFormation(piece.id);
    state.contextMenu = null;
  };
  ctxMenuEl.appendChild(leaveBtn);

  // Upgrade button (M5). Disabled when piece type is not yet eligible
  // (knight feint / king castling pending), when already L2, when no
  // stat threshold met, or when player can't afford. Tooltip explains why.
  const me = state.snapshot.players.find((p) => p.id === state.playerId);
  const upgradeCost = PIECE_VALUE[piece.type] * UPGRADE_COST_L2_MULT;
  const upBtn = document.createElement('button');
  const upStatus = upgradeStatus(piece, tickNow, me?.currency ?? 0);
  upBtn.textContent = upStatus.label;
  upBtn.disabled = !upStatus.canUpgrade;
  upBtn.title = upStatus.tooltip;
  upBtn.onclick = () => {
    net.sendUpgrade([piece.id]);
    state.contextMenu = null;
  };
  ctxMenuEl.appendChild(upBtn);

  // Upgrade All — appears when there are other selected own pieces beyond
  // this one. Iterates the selection; server rejects per-piece ineligible
  // entries silently except for the first error.
  const otherSelected = [...state.selectedPieceIds].filter((id) => id !== piece.id);
  if (otherSelected.length > 0) {
    const all = [piece.id, ...otherSelected];
    const eligibleIds = all.filter((id) => {
      const p = state.getPieceById(id);
      if (!p || p.ownerId !== state.playerId) return false;
      return canAffordAndEligible(p, tickNow, me?.currency ?? 0);
    });
    const upAllBtn = document.createElement('button');
    upAllBtn.textContent = `Upgrade all selected (${eligibleIds.length}/${all.length})`;
    upAllBtn.disabled = eligibleIds.length === 0;
    upAllBtn.onclick = () => {
      net.sendUpgrade(eligibleIds);
      state.contextMenu = null;
    };
    ctxMenuEl.appendChild(upAllBtn);
    void upgradeCost; // referenced in upgradeStatus above; silence lint
  }

  ctxMenuEl.appendChild(document.createElement('hr'));

  const sellBtn = document.createElement('button');
  sellBtn.textContent = piece.type === 'king' ? 'Sell (kings cannot be sold)' : `Sell for \u00A4${pieceValue(piece.type)}`;
  sellBtn.disabled = piece.type === 'king';
  sellBtn.onclick = () => {
    net.sendSellPiece(piece.id);
    state.contextMenu = null;
  };
  ctxMenuEl.appendChild(sellBtn);

  ctxMenuEl.style.display = 'block';
  ctxMenuEl.style.left = `${Math.min(ctx.screen.x, window.innerWidth - 220)}px`;
  ctxMenuEl.style.top = `${Math.min(ctx.screen.y, window.innerHeight - 200)}px`;
}

/** M3-era placeholder values; full table will move to a shared lookup later. */
function pieceValue(type: string): number {
  return ({ pawn: 100, knight: 200, bishop: 250, rook: 350, queen: 500, king: 500 } as Record<string, number>)[type] ?? 0;
}

/** True iff `piece` meets at least one of the L2 stat thresholds. Mirrors
 *  `World.isEligibleForUpgradeL2` server-side. */
function meetsThresholdL2(piece: Piece, currentTick: number): boolean {
  const age = currentTick - piece.bornTick;
  return (
    age >= LEVEL_UP_THRESHOLDS_L2.ageTicks ||
    (piece.kills ?? 0) >= LEVEL_UP_THRESHOLDS_L2.kills ||
    (piece.profit ?? 0) >= LEVEL_UP_THRESHOLDS_L2.profit
  );
}

/** True iff `piece` could be upgraded to L2 right now given `currency`. */
function canAffordAndEligible(piece: Piece, currentTick: number, currency: number): boolean {
  if (piece.level >= 2) return false;
  if (!(UPGRADE_ELIGIBLE_TYPES_L2 as readonly PieceType[]).includes(piece.type)) return false;
  if (!meetsThresholdL2(piece, currentTick)) return false;
  return currency >= PIECE_VALUE[piece.type] * UPGRADE_COST_L2_MULT;
}

/** Build the user-facing upgrade button state. */
function upgradeStatus(
  piece: Piece,
  currentTick: number,
  currency: number,
): { label: string; canUpgrade: boolean; tooltip: string } {
  const cost = PIECE_VALUE[piece.type] * UPGRADE_COST_L2_MULT;
  if (piece.level >= 2) {
    return { label: 'Upgraded (L2)', canUpgrade: false, tooltip: 'Already L2' };
  }
  if (!(UPGRADE_ELIGIBLE_TYPES_L2 as readonly PieceType[]).includes(piece.type)) {
    return {
      label: `Upgrade L2 \u2014 pending`,
      canUpgrade: false,
      tooltip: `${piece.type} L2 ability not yet implemented`,
    };
  }
  if (!meetsThresholdL2(piece, currentTick)) {
    return {
      label: `Upgrade L2 (\u00A4${cost}) \u2014 not eligible`,
      canUpgrade: false,
      tooltip: `Needs age \u2265 ${Math.round((LEVEL_UP_THRESHOLDS_L2.ageTicks * TICK_MS) / 1000)}s OR kills \u2265 ${LEVEL_UP_THRESHOLDS_L2.kills} OR profit \u2265 \u00A4${LEVEL_UP_THRESHOLDS_L2.profit}`,
    };
  }
  if (currency < cost) {
    return {
      label: `Upgrade L2 (\u00A4${cost})`,
      canUpgrade: false,
      tooltip: `Need \u00A4${cost}, have \u00A4${Math.floor(currency)}`,
    };
  }
  return {
    label: `Upgrade L2 (\u00A4${cost})`,
    canUpgrade: true,
    tooltip: `Spend \u00A4${cost} to unlock L2 abilities`,
  };
}

/** Build the shop bar once; each frame we just refresh disabled/armed state.
 *  Buttons can't be DOM-rebuilt every frame because that would swallow the
 *  click between mousedown and mouseup (same pattern as renderContextMenu). */
const SHOP_GLYPH: Record<PieceType, string> = {
  king: '\u265A', queen: '\u265B', rook: '\u265C',
  bishop: '\u265D', knight: '\u265E', pawn: '\u265F',
};
const shopButtons = new Map<PieceType, HTMLButtonElement>();
for (const type of BUYABLE_TYPES) {
  const btn = document.createElement('button');
  btn.dataset.type = type;
  const glyph = document.createElement('div');
  glyph.className = 'glyph';
  glyph.textContent = SHOP_GLYPH[type];
  const label = document.createElement('div');
  label.textContent = type;
  const cost = document.createElement('div');
  cost.className = 'cost';
  cost.textContent = `\u00A4${PIECE_VALUE[type]}`;
  btn.append(glyph, label, cost);
  btn.onclick = () => {
    // Toggle: clicking the armed type a second time cancels.
    if (state.placement?.kind === 'piece' && state.placement.type === type) {
      state.placement = null;
    } else {
      state.placement = { kind: 'piece', type };
    }
  };
  shopEl.appendChild(btn);
  shopButtons.set(type, btn);
}

// Bomb shop button — distinct from piece buttons because it spawns terrain,
// not a unit, and uses its own placement-mode kind so input/render branch
// on { kind: 'bomb' } instead of { kind: 'piece', type }.
const bombBtn = document.createElement('button');
bombBtn.dataset.type = 'bomb';
{
  const glyph = document.createElement('div');
  glyph.className = 'glyph';
  glyph.textContent = '\uD83D\uDCA3'; // bomb emoji
  const label = document.createElement('div');
  label.textContent = 'bomb';
  const cost = document.createElement('div');
  cost.className = 'cost';
  cost.textContent = `\u00A4${BOMB_COST}`;
  bombBtn.append(glyph, label, cost);
  bombBtn.onclick = () => {
    if (state.placement?.kind === 'bomb') state.placement = null;
    else state.placement = { kind: 'bomb' };
  };
  shopEl.appendChild(bombBtn);
}

function updateShop(): void {
  const me = state.snapshot.players.find((p) => p.id === state.playerId);
  const currency = me?.currency ?? 0;
  const armedType = state.placement?.kind === 'piece' ? state.placement.type : null;
  for (const [type, btn] of shopButtons) {
    btn.disabled = !me || currency < PIECE_VALUE[type];
    btn.classList.toggle('armed', armedType === type);
  }
  bombBtn.disabled = !me || currency < BOMB_COST;
  bombBtn.classList.toggle('armed', state.placement?.kind === 'bomb');
}

/**
 * Push our viewport to the server periodically (or sooner when it changes
 * meaningfully) so it only streams pieces we can actually see.
 */
let lastViewportSent = 0;
let lastViewportKey = '';
function maybeSendViewport(now: number): void {
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);
  const r = camera.visibleRange(w, h);
  const key = `${r.minX},${r.minY},${r.maxX},${r.maxY}`;
  const changed = key !== lastViewportKey;
  if (changed || now - lastViewportSent > 500) {
    net.sendViewport(r);
    lastViewportKey = key;
    lastViewportSent = now;
  }
}

function updateHud(): void {
  const me = state.snapshot.players.find((p) => p.id === state.playerId);
  if (!state.playerId) {
    currencyEl.textContent = '';
  } else if (!me) {
    currencyEl.textContent = 'your king was captured — game over';
    currencyEl.style.color = '#f87171';
  } else {
    currencyEl.textContent = `\u00A4 ${Math.floor(me.currency)}`;
    currencyEl.style.color = '#ffd479';
  }
  coordsHover.textContent = state.hoverSquare
    ? `${state.hoverSquare.x}, ${state.hoverSquare.y}`
    : '—';
  coordsView.textContent = `${Math.round(camera.centerX)}, ${Math.round(camera.centerY)}`;
}

function frame(now: number): void {
  input.updatePan(now);
  maybeSendViewport(now);
  renderer.draw(now);
  updateHud();
  updateShop();
  renderContextMenu();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
