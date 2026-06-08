import { TILE_PX, ZOOM_MAX_TILE_PX, ZOOM_MIN_TILE_PX } from '@infinitechess/shared';
import type { Coord } from '@infinitechess/shared';

/** Maps between world coordinates (integer squares) and screen pixels. */
export class Camera {
  /** World-space coordinate at the center of the viewport (can be fractional for smooth pan). */
  centerX = 0;
  centerY = 0;
  tileSize = TILE_PX;

  worldToScreen(world: Coord, viewportW: number, viewportH: number): { x: number; y: number } {
    return {
      x: viewportW / 2 + (world.x - this.centerX) * this.tileSize,
      y: viewportH / 2 + (world.y - this.centerY) * this.tileSize,
    };
  }

  /** Real-valued (fractional) world coordinate under a screen pixel. */
  screenToWorld(sx: number, sy: number, viewportW: number, viewportH: number): { x: number; y: number } {
    return {
      x: (sx - viewportW / 2) / this.tileSize + this.centerX,
      y: (sy - viewportH / 2) / this.tileSize + this.centerY,
    };
  }

  screenToWorldSquare(sx: number, sy: number, viewportW: number, viewportH: number): Coord {
    return {
      x: Math.floor((sx - viewportW / 2) / this.tileSize + this.centerX + 0.5),
      y: Math.floor((sy - viewportH / 2) / this.tileSize + this.centerY + 0.5),
    };
  }

  /**
   * Zoom by `factor` (e.g. 1.1 = zoom in, 1/1.1 = zoom out), keeping the
   * world point currently under (screenX, screenY) anchored to the same
   * pixel after the zoom. Clamped to [ZOOM_MIN_TILE_PX, ZOOM_MAX_TILE_PX];
   * if the requested factor would push tileSize past either bound, the
   * actual scale is reduced so we stop exactly at the bound (no slip).
   */
  zoomBy(factor: number, screenX: number, screenY: number, viewportW: number, viewportH: number): void {
    const before = this.tileSize;
    const target = before * factor;
    const clamped = Math.max(ZOOM_MIN_TILE_PX, Math.min(ZOOM_MAX_TILE_PX, target));
    if (clamped === before) return;
    const anchorWorld = this.screenToWorld(screenX, screenY, viewportW, viewportH);
    this.tileSize = clamped;
    // After the change, recompute what world point sits under (sx, sy) and
    // shift the camera center so it matches the pre-zoom anchor.
    const afterWorld = this.screenToWorld(screenX, screenY, viewportW, viewportH);
    this.centerX += anchorWorld.x - afterWorld.x;
    this.centerY += anchorWorld.y - afterWorld.y;
  }

  /** Inclusive ranges of world squares currently visible. */
  visibleRange(viewportW: number, viewportH: number): {
    minX: number; maxX: number; minY: number; maxY: number;
  } {
    const halfCols = Math.ceil(viewportW / 2 / this.tileSize) + 1;
    const halfRows = Math.ceil(viewportH / 2 / this.tileSize) + 1;
    return {
      minX: Math.floor(this.centerX) - halfCols,
      maxX: Math.floor(this.centerX) + halfCols,
      minY: Math.floor(this.centerY) - halfRows,
      maxY: Math.floor(this.centerY) + halfRows,
    };
  }
}
