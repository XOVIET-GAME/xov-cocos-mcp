'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readOptionalText(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeTextIfUnchanged(filePath, content, original) {
  // Preserve symlinked config locations while replacing the real file atomically.
  const destination = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.funplay-${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const mode = fs.existsSync(destination) ? fs.statSync(destination).mode & 0o777 : 0o600;
    fs.writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode });
    if (readOptionalText(filePath) !== original) throw new Error(`Configuration changed while editing: ${filePath}. Retry after reviewing it.`);
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function writeFileAtomic(filePath, content, options = {}) {
  const mode = (options && typeof options.mode === 'number') ? options.mode : 0o600;
  const encoding = (options && options.encoding) || 'utf8';
  const destination = fs.existsSync(filePath) ? fs.realpathSync(filePath) : filePath;
  const dir = path.dirname(destination);
  fs.mkdirSync(dir, { recursive: true });
  const temporary = `${destination}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', mode);
    try {
      fs.fchmodSync(fd, mode);
    } catch (_) {}
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(fd, content);
    } else if (typeof content === 'string') {
      fs.writeFileSync(fd, content, { encoding });
    } else {
      throw new TypeError('content must be a string or Buffer');
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, destination);
  } catch (error) {
    if (fd !== undefined && fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try {
      if (fs.existsSync(temporary)) {
        fs.unlinkSync(temporary);
      }
    } catch (_) {}
    throw error;
  }
}

module.exports = { readOptionalText, writeTextIfUnchanged, writeFileAtomic };
