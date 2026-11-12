const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { LocalStore } = require('../dist-electron/store');

function fixture(initialSize = {}, initialX = 500, onSizeChange = () => {}, showInitially = false) {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
  const cursor = { x: 0, y: 0 };
  let focused = true;
  let now = 1000;
  const intervals = new Set();
  const window = {
    visible: false,
    bounds: { x: initialX, y: 0, width: 460, height: 650 },
    min: [0, 0], max: [0, 0],
    isDestroyed: () => false,
    getBounds() { return { ...this.bounds }; },
    setMinimumSize(width, height) { this.min = [width, height]; },
    setMaximumSize(width, height) { this.max = [width, height]; },
    isFocused() { return focused; },
    setBounds(bounds) {
      this.bounds = { ...bounds,
        width: Math.min(this.max[0] || Infinity, Math.max(this.min[0], bounds.width)),
        height: Math.min(this.max[1] || Infinity, Math.max(this.min[1], bounds.height)),
      };
    },
    show() { this.visible = true; }, showInactive() { this.visible = true; }, focus() {},
    hide() { this.visible = false; }, isVisible() { return this.visible; },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist-electron/dock.js'), 'utf8'), {
    exports: module.exports,
    require: name => name === 'electron'
      ? { screen: { getPrimaryDisplay: () => display, getCursorScreenPoint: () => ({ ...cursor }) } }
      : require('../dist-electron/domain'),
    Date: { now: () => now },
    setInterval: fn => { intervals.add(fn); return fn; },
    clearInterval: fn => intervals.delete(fn),
  });
  const dock = new module.exports.DockWindow(window, initialX, () => {}, initialSize, onSizeChange);
  dock.start(showInitially);
  return { dock, window, cursor, display,
    setFocused(value) { focused = value; },
    advance(ms) { now += ms; for (const fn of [...intervals]) fn(); },
  };
}

test('fully hidden window opens at the saved top edge, with no visible trigger window', () => {
  const { dock, window, cursor, advance } = fixture({ width: 390, height: 510 }, 700);
  assert.equal(window.visible, false);
  assert.equal(window.bounds.y + window.bounds.height, 0);
  cursor.x = 699; cursor.y = 0; advance(200);
  assert.equal(window.visible, false);
  cursor.x = 800; cursor.y = 3; advance(200);
  assert.equal(window.visible, false);
  cursor.y = -1; advance(200);
  assert.equal(window.visible, false);
  cursor.y = 0; advance(30); advance(200);
  assert.equal(window.visible, true); assert.equal(window.bounds.y, 0);
  dock.hide(); advance(120);
  assert.equal(window.visible, false);
  advance(100); assert.equal(window.visible, false); // Click-hide suppression.
  advance(400); advance(200); assert.equal(window.visible, true);
  assert.equal(window.bounds.width, 390);
  dock.dispose();
});

test('native hide removes every pixel even if Windows clamps negative window coordinates', () => {
  const { dock, window, advance } = fixture({}, 500, () => {}, true);
  const setBounds = window.setBounds.bind(window);
  window.setBounds = bounds => setBounds({ ...bounds, y: Math.max(-640, bounds.y) });
  dock.hide(); advance(120);
  assert.equal(window.visible, false);
  assert.ok(window.bounds.y + window.bounds.height > 0); // Native visibility wins.
  dock.show(true); advance(200);
  assert.equal(window.visible, true); assert.equal(window.bounds.y, 0);
  dock.dispose();
});

test('show during retract and monitor reposition cannot leave a stranded visible sliver', () => {
  const { dock, window, cursor, advance, display } = fixture({}, 500, () => {}, true);
  dock.hide(); advance(50); dock.show(); advance(200);
  assert.equal(window.visible, true); assert.equal(window.bounds.y, 0);
  dock.hide(); advance(120);
  display.bounds.y = -100; display.workArea.y = -100;
  dock.reposition(); assert.equal(window.visible, false);
  cursor.x = 600; cursor.y = -100; advance(500); advance(200);
  assert.equal(window.visible, true); assert.equal(window.bounds.y, -100);
  dock.dispose();
});

test('initial visibility grace is short and then auto-hides when the pointer is outside', () => {
  const { dock, window, advance } = fixture({}, 500, () => {}, true);
  advance(2100);
  assert.equal(window.bounds.y, 0);
  advance(120);
  advance(120);
  assert.equal(window.bounds.y, -650);
  assert.equal(window.visible, false);
  dock.dispose();
});

test('a stale keep-open flag cannot block auto-hide after the window loses focus', () => {
  const { dock, window, advance, setFocused } = fixture();
  dock.show(true);
  advance(200);
  dock.setKeepOpen(true);
  advance(120);
  assert.equal(window.bounds.y, 0);
  setFocused(false);
  advance(120);
  advance(120);
  advance(120);
  assert.equal(window.bounds.y, -650);
  assert.equal(window.visible, false);
  dock.dispose();
});

test('corner resizing changes both dimensions and hidden geometry follows the new height', () => {
  const saved = [];
  const { dock, window, cursor } = fixture({}, 500, size => saved.push(size));
  cursor.x = 950; cursor.y = 640;
  dock.startResize('bottom-right');
  cursor.x -= 50; cursor.y -= 100;
  dock.moveResize();
  dock.endResize();
  assert.equal(window.bounds.width, 410);
  assert.equal(window.bounds.height, 550);
  assert.equal(window.bounds.x, 500);
  assert.equal(window.bounds.y, 0);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].width, 410);
  assert.equal(saved[0].height, 550);
  dock.reposition(false);
  assert.equal(window.bounds.y, -550);
  assert.equal(window.visible, false);
  dock.dispose();
});

test('right and bottom handles adjust only their respective dimension', () => {
  const { dock, window, cursor } = fixture();
  dock.startResize('right');
  cursor.x += 100; cursor.y += 100;
  dock.endResize();
  assert.equal(window.bounds.width, 560);
  assert.equal(window.bounds.height, 650);
  dock.startResize('bottom');
  cursor.x -= 100; cursor.y += 100;
  dock.endResize();
  assert.equal(window.bounds.width, 560);
  assert.equal(window.bounds.height, 750);
  dock.dispose();
});

test('title dragging after resizing preserves the chosen dimensions', () => {
  const { dock, window, cursor } = fixture({ width: 390, height: 510 });
  dock.reposition(true);
  cursor.x = 520;
  dock.startDrag();
  cursor.x += 190; cursor.y += 80;
  dock.endDrag();
  assert.equal(window.bounds.x, 690);
  assert.equal(window.bounds.width, 390);
  assert.equal(window.bounds.height, 510);
  assert.equal(window.bounds.y, 0);
  dock.dispose();
});

test('resizing respects minimums and screen edges and does not auto-hide during the gesture', () => {
  const { dock, window, cursor, advance } = fixture({}, 1460);
  dock.startResize('bottom-right');
  cursor.x = 5000; cursor.y = 5000;
  advance(100000);
  assert.equal(window.bounds.width, 460);
  assert.equal(window.bounds.height, 1040);
  assert.equal(window.bounds.y, 0);
  cursor.x = -5000; cursor.y = -5000;
  dock.endResize();
  assert.equal(window.bounds.width, 360);
  assert.equal(window.bounds.height, 480);
  dock.dispose();
});

test('custom size survives a saved-settings round trip and reset restores the default', () => {
  fs.mkdirSync(path.join(__dirname, '../work'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(__dirname, '../work/dock-settings-test-'));
  try {
    const store = new LocalStore(directory);
    const first = fixture({}, 500, size => store.saveSettings({ dockWidth: size.width, dockHeight: size.height }));
    first.dock.startResize('bottom-right');
    first.cursor.x = -70; first.cursor.y = -120;
    first.dock.endResize();
    first.dock.dispose();
    const saved = new LocalStore(directory).settings();
    const second = fixture({ width: saved.dockWidth, height: saved.dockHeight });
    assert.equal(second.window.bounds.width, 390);
    assert.equal(second.window.bounds.height, 530);
    second.dock.resetSize();
    assert.equal(second.window.bounds.width, 460);
    assert.equal(second.window.bounds.height, 650);
    second.dock.dispose();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
