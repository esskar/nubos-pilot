'use strict';

const { makeReadlineAdapter } = require('./_factory.cjs');

module.exports = makeReadlineAdapter({
  name: 'codex',
  detectHints: {
    env: ['CODEX_HOME', 'CODEX_VERSION'],
    pathBinary: 'codex',
    diskMarkers: ['.codex/'],
  },
  capabilities: {
    askUserQuestion: false,
    slashCommands: false,
    agentsMd: 'AGENTS.md',
    textMode: 'auto',
    modelResolution: 'profile',
  },
  paths: {
    payload: null,
    config: null,
    agentsMd: 'AGENTS.md',
  },
  runtimeNotice:
    '> **Runtime-Hinweis:** Diese Datei wird von Codex/Gemini/OpenCode konsumiert. '
    + 'Interaktive Prompts laufen über readline (stderr), nicht über das Claude-spezifische AskUser-Tool.',
});
