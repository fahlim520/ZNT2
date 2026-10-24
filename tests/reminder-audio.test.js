const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeReminderAudioFolder, reminderAudioFiles, readNextReminderSound } = require('../dist-electron/reminder-audio');
const { LocalStore } = require('../dist-electron/store');
const bundled = path.resolve(__dirname, '../assets/reminder-audio');
const names = ['冰.wav', '牛.wav', '哇哦.wav'];

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qing-task-audio-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('fresh installations get the three real bundled WAV files without a download', t => {
  const directory = path.join(temporaryDirectory(t), '提醒音频');
  initializeReminderAudioFolder(directory, [bundled]);
  assert.deepEqual(reminderAudioFiles([directory]).map(file => path.basename(file)), names);
  for (const name of names) {
    const original = fs.readFileSync(path.join(bundled, name));
    assert.equal(original.subarray(0, 4).toString(), 'RIFF');
    assert.equal(original.subarray(8, 12).toString(), 'WAVE');
    assert.ok(original.length > 44);
    assert.deepEqual(fs.readFileSync(path.join(directory, name)), original);
  }
});

test('audio rotation wraps after three files and resumes from the saved index', t => {
  const directory = temporaryDirectory(t);
  const profile = path.join(directory, 'profile');
  const heard = [];
  for (let n = 0; n < 7; n++) {
    const store = new LocalStore(profile);
    const saved = store.settings();
    const next = readNextReminderSound([bundled], saved.reminderSoundIndex);
    heard.push(next.sound.name);
    assert.equal(next.sound.total, 3);
    assert.ok(next.sound.dataUrl.startsWith('data:audio/wav;base64,'));
    store.saveSettings({ ...saved, reminderSoundIndex: next.nextIndex });
  }
  assert.deepEqual(heard, [...names, ...names, names[0]]);
});

test('existing custom sounds stay untouched and file changes are picked up at the next reminder', t => {
  const directory = temporaryDirectory(t);
  for (const name of ['10.wav', '2.WAV']) fs.copyFileSync(path.join(bundled, names[0]), path.join(directory, name));
  fs.writeFileSync(path.join(directory, '说明.txt'), 'ignore');
  initializeReminderAudioFolder(directory, [bundled]);
  assert.deepEqual(reminderAudioFiles([directory]).map(file => path.basename(file)), ['2.WAV', '10.wav']);
  assert.equal(readNextReminderSound([directory, bundled], 0).sound.name, '2.WAV');
  fs.copyFileSync(path.join(bundled, names[1]), path.join(directory, '3.wav'));
  assert.equal(readNextReminderSound([directory, bundled], 1).sound.name, '3.wav');
  fs.unlinkSync(path.join(directory, '2.WAV'));
  initializeReminderAudioFolder(directory, [bundled]);
  assert.deepEqual(reminderAudioFiles([directory]).map(file => path.basename(file)), ['3.wav', '10.wav']);
});

test('legacy custom sounds migrate before defaults and are not overwritten or duplicated', t => {
  const root = temporaryDirectory(t);
  const legacy = path.join(root, 'legacy');
  const current = path.join(root, 'current');
  fs.mkdirSync(legacy);
  const original = fs.readFileSync(path.join(bundled, names[1]));
  fs.writeFileSync(path.join(legacy, 'my-sound.wav'), original);
  initializeReminderAudioFolder(current, [legacy, bundled]);
  initializeReminderAudioFolder(current, [legacy, bundled]);
  assert.deepEqual(fs.readdirSync(current), ['my-sound.wav']);
  assert.deepEqual(fs.readFileSync(path.join(current, 'my-sound.wav')), original);
  assert.deepEqual(fs.readFileSync(path.join(legacy, 'my-sound.wav')), original);
});

test('empty, missing and unreadable audio lists fall back to bundled defaults', t => {
  const directory = temporaryDirectory(t);
  fs.writeFileSync(path.join(directory, 'empty.wav'), '');
  assert.equal(readNextReminderSound([directory, bundled], -1).sound.name, names[0]);
  assert.equal(readNextReminderSound([path.join(directory, 'missing'), bundled], NaN).sound.name, names[0]);
  assert.equal(readNextReminderSound([directory], 0), undefined);
  fs.unlinkSync(path.join(directory, 'empty.wav'));
  assert.equal(readNextReminderSound([directory, bundled], 4).sound.name, names[1]);
});
