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
    show() {}, showInactive() {}, focus() {},
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

test('initial visibility grace is short and then auto-hides when the pointer is outside', () => {
  const { dock, window, advance } = fixture({}, 500, () => {}, true);
  advance(2100);
  assert.equal(window.bounds.y, 0);
  advance(120);
  advance(120);
  assert.equal(window.bounds.y, -642);
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
  assert.equal(window.bounds.y, -642);
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
  assert.equal(window.bounds.y, -542);
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
