import { BrowserWindow, screen } from 'electron';
import { DEFAULT_DOCK_SIZE, dockGeometry, type DockSize, type ResizeEdge } from './domain';

const INITIAL_SHOW_GRACE_MS = 2_000;
const OUTSIDE_HIDE_DELAY_MS = 120;

// Hide all but the bottom 8px edge strip. The handle must be at the bottom of
// the renderer, otherwise a negative window Y would hide the trigger itself.
export class DockWindow {
  private expanded = false;
  private targetExpanded = false;
  private animation?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private outsideSince?: number;
  private keepOpen = false;
  private suppressedUntil = 0;
  private startupVisibleUntil = 0;
  private dragging = false;
  private dragOffsetX = 0;
  private preferredX?: number;
  private preferredSize: Partial<DockSize>;
  private resizing?: { edge: ResizeEdge; cursorX: number; cursorY: number; x: number; width: number; height: number };
  paused = false;

  constructor(readonly window: BrowserWindow, initialX?: number, private readonly onPositionChange?: (x: number) => void,
    initialSize: Partial<DockSize> = {}, private readonly onSizeChange?: (size: DockSize) => void) {
    this.preferredX = Number.isFinite(initialX) ? Math.round(initialX as number) : undefined;
    this.preferredSize = initialSize;
  }
  geometry() {
    const display = screen.getPrimaryDisplay();
    const geometry = dockGeometry(display, this.preferredSize);
    // Electron's display metrics can briefly be incomplete while Windows is
    // restoring the desktop. Never pass NaN/undefined coordinates to the
    // native BrowserWindow APIs during that transition.
    const fallback = {
      x: Number(display.workArea?.x) || 0,
      y: Number(display.bounds?.y) || 0,
      width: Number(display.workArea?.width) || 460,
      height: Number(display.workArea?.height) || 650,
    };
    const width = Number.isFinite(geometry.width) && geometry.width > 0 ? Math.round(geometry.width) : Math.min(460, fallback.width);
    const height = Number.isFinite(geometry.height) && geometry.height > 0 ? Math.round(geometry.height) : Math.min(650, fallback.height);
    const centeredX = Number.isFinite(geometry.x) ? Math.round(geometry.x) : Math.round(fallback.x + (fallback.width - width) / 2);
    const minX = Number.isFinite(display.workArea?.x) ? Math.round(display.workArea.x) : fallback.x;
    const maxX = Math.max(minX, minX + Math.max(0, fallback.width - width));
    const requestedX = Number.isFinite(this.preferredX) ? Math.round(this.preferredX as number) : centeredX;
    const x = Math.max(minX, Math.min(maxX, requestedX));
    const shownY = Number.isFinite(geometry.shownY) ? Math.round(geometry.shownY) : Math.round(fallback.y);
    const hiddenY = Number.isFinite(geometry.hiddenY) ? Math.round(geometry.hiddenY) : shownY - height + 8;
    return { x, shownY, hiddenY, width, height };
  }
  start(showInitially: boolean) {
    this.reposition(showInitially);
    if (showInitially) {
      // Keep the first launch open long enough for the user to notice the
      // window and discover the top-edge handle. It will still return to the
      // edge automatically after this short onboarding period.
      this.startupVisibleUntil = Date.now() + INITIAL_SHOW_GRACE_MS;
      this.window.show();
      this.window.focus();
    } else {
      this.window.showInactive();
    }
    this.poll = setInterval(() => this.tick(), 30);
  }
  reposition(expanded = this.targetExpanded) {
    this.stopAnimation();
    const g = this.geometry();
    this.expanded = this.targetExpanded = expanded;
    const y = expanded ? g.shownY : g.hiddenY;
    if ([g.x, y, g.width, g.height].every(Number.isFinite)) {
      this.applyBounds(g, y);
    }
  }
  private applyBounds(g: { x: number; width: number; height: number }, y: number) {
    const bounds = this.window.getBounds();
    if (bounds.width !== g.width || bounds.height !== g.height) {
      // Release the previous size lock before an intentional resize, then lock
      // the new size so dragging the title bar can never change the width.
      this.window.setMinimumSize(0, 0);
      this.window.setMaximumSize(0, 0);
    }
    this.window.setBounds({ x: g.x, y, width: g.width, height: g.height }, false);
    this.window.setMinimumSize(g.width, g.height);
    this.window.setMaximumSize(g.width, g.height);
  }
  private stopAnimation() { clearInterval(this.animation); this.animation = undefined; }
  show(focus = false) {
    this.outsideSince = undefined;
    if (focus) { this.window.show(); this.window.focus(); } else this.window.showInactive();
    this.animate(true);
  }
  hide() { this.endResize(); this.suppressedUntil = Date.now() + 450; this.outsideSince = undefined; this.animate(false); }
  toggle() { if (this.targetExpanded) this.hide(); else this.show(true); }
  setKeepOpen(value: boolean) { this.keepOpen = value; this.outsideSince = undefined; }
  setPaused(value: boolean) { this.paused = value; this.outsideSince = undefined; if (value) this.show(); }
  startDrag() {
    if (this.window.isDestroyed() || this.resizing) return;
    const cursor = screen.getCursorScreenPoint();
    const bounds = this.window.getBounds();
    this.dragging = true;
    this.dragOffsetX = cursor.x - bounds.x;
    this.preferredX = bounds.x;
    this.outsideSince = undefined;
    this.stopAnimation();
  }
  moveDrag() {
    if (!this.dragging || this.window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const g = this.geometry();
    const minX = screen.getPrimaryDisplay().workArea.x;
    const maxX = minX + Math.max(0, screen.getPrimaryDisplay().workArea.width - g.width);
    const x = Math.max(minX, Math.min(maxX, Math.round(cursor.x - this.dragOffsetX)));
    this.preferredX = x;
    const bounds = this.window.getBounds();
    if ([x, bounds.y, g.width, g.height].every(Number.isFinite)) {
      // Set the size together with the position so dragging can never alter
      // the panel width, including when Windows reports a DPI transition.
      this.applyBounds({ x, width: g.width, height: g.height }, bounds.y);
    }
  }
  endDrag() {
    if (!this.dragging) return;
    this.moveDrag();
    this.dragging = false;
    if (Number.isFinite(this.preferredX)) this.onPositionChange?.(Math.round(this.preferredX as number));
  }
  startResize(edge: ResizeEdge) {
    if (this.window.isDestroyed() || this.resizing) return;
    this.endDrag();
    this.reposition(true);
    const cursor = screen.getCursorScreenPoint();
    const g = this.geometry();
    this.preferredX = g.x;
    this.resizing = { edge, cursorX: cursor.x, cursorY: cursor.y, x: g.x, width: g.width, height: g.height };
    this.outsideSince = undefined;
  }
  moveResize() {
    const start = this.resizing;
    if (!start || this.window.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getPrimaryDisplay();
    const width = start.edge === 'bottom' ? start.width : Math.min(display.workArea.x + display.workArea.width - start.x, start.width + cursor.x - start.cursorX);
    const height = start.edge === 'right' ? start.height : start.height + cursor.y - start.cursorY;
    const g = dockGeometry(display, { width, height });
    this.preferredSize = { width: g.width, height: g.height };
    this.preferredX = start.x;
    this.applyBounds(this.geometry(), g.shownY);
  }
  endResize() {
    if (!this.resizing) return;
    this.moveResize();
    this.resizing = undefined;
    this.outsideSince = undefined;
    const { width, height } = this.geometry();
    this.onSizeChange?.({ width, height });
    if (Number.isFinite(this.preferredX)) this.onPositionChange?.(this.preferredX!);
  }
  resetSize(): DockSize {
    this.endResize();
    this.endDrag();
    this.preferredSize = { ...DEFAULT_DOCK_SIZE };
    this.reposition();
    const { width, height } = this.geometry();
    this.onSizeChange?.({ width, height });
    return { width, height };
  }
  private animate(show: boolean) {
    if (this.targetExpanded === show && (this.animation || this.expanded === show)) return;
    this.stopAnimation();
    this.targetExpanded = show;
    const g = this.geometry();
    const currentY = this.window.getBounds().y;
    const from = Number.isFinite(currentY) ? Math.round(currentY) : g.hiddenY;
    const target = Number.isFinite(show ? g.shownY : g.hiddenY) ? Math.round(show ? g.shownY : g.hiddenY) : from;
    const start = Date.now();
    this.animation = setInterval(() => {
      try {
        if (this.window.isDestroyed()) { this.stopAnimation(); return; }
        const duration = show ? 180 : 110;
        const progress = Math.min(1, (Date.now() - start) / duration);
        const ease = 1 - Math.pow(1 - progress, 3);
        const y = Math.round(from + (target - from) * ease);
        if ([g.x, y, g.width, g.height].every(Number.isFinite)) {
          this.applyBounds(g, y);
        }
        if (progress >= 1) { this.stopAnimation(); this.expanded = show; }
      } catch {
        // A display can disappear while the animation is running. Do not let
        // an Electron native coordinate conversion terminate the main process.
        this.stopAnimation();
      }
    }, 16);
  }
  private tick() {
    try {
      if (this.window.isDestroyed()) return;
      const p = screen.getCursorScreenPoint();
      const g = this.geometry();
      if (![p.x, p.y, g.x, g.shownY, g.width, g.height].every(Number.isFinite)) return;
      if (this.resizing) { this.moveResize(); return; }
      if (this.dragging) { this.moveDrag(); return; }
      // Only the primary display's top centre triggers; a display above it won't.
      const trigger = p.y >= g.shownY && p.y <= g.shownY + 5 && p.x >= g.x && p.x <= g.x + g.width;
      const b = this.window.getBounds();
      const inside = [b.x, b.y, b.width, b.height].every(Number.isFinite)
        && p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (!this.targetExpanded && trigger && Date.now() >= this.suppressedUntil) this.show();
      if (Date.now() < this.startupVisibleUntil) { this.outsideSince = undefined; return; }
      // A focused editor/modal should stay open while the user is working.
      // Once another app takes focus, renderer focus state can remain latched;
      // do not let that stale keep-open flag block auto-hide indefinitely.
      const keepOpen = this.keepOpen && this.window.isFocused();
      if (!this.targetExpanded || this.animation || this.paused || keepOpen || inside) { this.outsideSince = undefined; return; }
      this.outsideSince ??= Date.now();
      if (Date.now() - this.outsideSince >= OUTSIDE_HIDE_DELAY_MS) this.hide();
    } catch {
      // Windows can briefly report incomplete display metrics during resume,
      // docking, or display changes. Keep the tray app alive and retry next tick.
    }
  }
  dispose() { this.endResize(); this.endDrag(); this.stopAnimation(); clearInterval(this.poll); }
}
