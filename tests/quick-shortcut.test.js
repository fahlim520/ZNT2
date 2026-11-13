const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_QUICK_SHORTCUT, QuickShortcut, normalizeShortcut } = require('../dist-electron/quick-shortcut');
test('top-left tilde key uses Ctrl plus backquote without implicit Shift', () => {
  assert.equal(DEFAULT_QUICK_SHORTCUT, 'Ctrl+`');
  for (const input of ['Ctrl+`', 'Ctrl+~', 'Ctrl+Backquote']) assert.equal(normalizeShortcut(input), 'Ctrl+`');
  assert.equal(normalizeShortcut('Alt + Ctrl + ~'), 'Ctrl+Alt+`');
  assert.equal(normalizeShortcut('Ctrl+Shift+~'), 'Ctrl+Shift+`');
  const calls = []; const shortcut = new QuickShortcut({ register: key => { calls.push(key); return true; }, unregister: () => {} }, () => {});
  shortcut.start(DEFAULT_QUICK_SHORTCUT);
  assert.deepEqual(calls, ['Ctrl+`']); assert.equal(shortcut.active, 'Ctrl+`');
});
test('validates keyboard combinations and normalizes modifier order', () => {
  assert.equal(normalizeShortcut('Alt + Ctrl + q'), 'Ctrl+Alt+Q');
  assert.equal(normalizeShortcut('Ctrl+Shift+F12'), 'Ctrl+Shift+F12');
  assert.equal(normalizeShortcut(''), '');
  for (const bad of ['Q', 'Shift+Q', 'Ctrl+Ctrl+Q', 'Ctrl+C', 'Alt+F4', 'Ctrl+F25', 'Win+Q', {}, null]) assert.throws(() => normalizeShortcut(bad));
});
test('conflict and persistence failure keep the previous binding; disabling unregisters it', () => {
  const keys = new Map(); let saved = ''; let invoked = 0;
  const host = { register(key, cb) { if (key === 'Ctrl+Alt+X') return false; keys.set(key, cb); return true; }, unregister(key) { keys.delete(key); } };
  const shortcut = new QuickShortcut(host, () => invoked++);
  shortcut.change('Ctrl+Alt+Q', value => { saved = value; });
  keys.get(saved)(); assert.equal(invoked, 1);
  assert.throws(() => shortcut.change('Ctrl+Alt+X', value => { saved = value; }), /占用/);
  assert.equal(saved, 'Ctrl+Alt+Q'); assert.deepEqual([...keys.keys()], [saved]);
  assert.throws(() => shortcut.change('Ctrl+Alt+J', () => { throw Error('disk full'); }), /disk full/);
  assert.deepEqual([...keys.keys()], [saved]);
  shortcut.change('Ctrl+Alt+J', value => { saved = value; });
  assert.deepEqual([...keys.keys()], ['Ctrl+Alt+J']);
  shortcut.change('', value => { saved = value; });
  assert.equal(saved, ''); assert.equal(keys.size, 0);
  shortcut.start('Ctrl+Alt+X'); assert.match(shortcut.error, /占用/);
  shortcut.start('Ctrl+Alt+Q'); assert.equal(shortcut.error, '');
  shortcut.dispose(); assert.equal(keys.size, 0);
});
