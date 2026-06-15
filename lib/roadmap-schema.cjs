'use strict';

const path = require('node:path');
const { NubosPilotError } = require('./core.cjs');

const CURRENT_SCHEMA_VERSION = 2;
const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2]);

function validateSchemaVersion(doc, p) {
  if (!doc || typeof doc !== 'object') return 1;
  const raw = doc.schema_version;
  if (raw === undefined || raw === null) return 1;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new NubosPilotError(
      'roadmap-unsupported-schema',
      'roadmap.yaml schema_version must be integer',
      {
        file: path.basename(p),
        got: typeof raw,
        supported: SUPPORTED_SCHEMA_VERSIONS.slice(),
      },
    );
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(raw)) {
    throw new NubosPilotError(
      'roadmap-unsupported-schema',
      'roadmap.yaml schema_version=' + raw + ' not supported',
      {
        file: path.basename(p),
        got: raw,
        supported: SUPPORTED_SCHEMA_VERSIONS.slice(),
      },
    );
  }
  return raw;
}

module.exports = {
  validateSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
};
