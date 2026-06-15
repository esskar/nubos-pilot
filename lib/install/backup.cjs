const fs = require('node:fs');
const { NubosPilotError } = require('../core.cjs');

const MAX_NUMBERED_BACKUPS = 99;

function _refuseSymlink(filePath) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    throw new NubosPilotError(
      'backup-source-missing',
      'Cannot stat file to back up: ' + (err && err.message),
      { filePath },
    );
  }
  if (st.isSymbolicLink()) {
    throw new NubosPilotError(
      'backup-refuses-symlink',
      'Refusing to back up a symlink (would dereference target): ' + filePath,
      { filePath },
    );
  }
}

function _moveExclusive(filePath, candidate) {
  fs.copyFileSync(filePath, candidate, fs.constants.COPYFILE_EXCL);
  fs.unlinkSync(filePath);
}

function backupFile(filePath) {
  _refuseSymlink(filePath);
  const base = filePath + '.bak';
  try {
    _moveExclusive(filePath, base);
    return base;
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw new NubosPilotError(
        'backup-rename-failed',
        'Cannot back up to .bak: ' + (err && err.message),
        { filePath, target: base },
      );
    }
  }
  for (let n = 1; n <= MAX_NUMBERED_BACKUPS; n++) {
    const candidate = `${filePath}.bak.${n}`;
    try {
      _moveExclusive(filePath, candidate);
      return candidate;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw new NubosPilotError(
          'backup-rename-failed',
          'Cannot back up to ' + candidate + ': ' + (err && err.message),
          { filePath, target: candidate },
        );
      }
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const fallback = `${filePath}.bak.orphan-${ts}`;
  try {
    _moveExclusive(filePath, fallback);
  } catch (err) {
    throw new NubosPilotError(
      'backup-rename-failed',
      'Cannot back up to orphan backup: ' + (err && err.message),
      { filePath, target: fallback },
    );
  }
  return fallback;
}

module.exports = { backupFile, MAX_NUMBERED_BACKUPS };
