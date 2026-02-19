'use strict';

import React from 'react';
import { render } from 'ink';
import { parseArgs } from 'node:util';
import { App } from './App.js';

function main() {
  const { values } = parseArgs({
    options: {
      mqtt:          { type: 'string',  default: 'ws://localhost:8080' },
      'min-players': { type: 'string',  default: '2' },
    },
    strict: false,
  });

  const mqttUrl    = values.mqtt;
  const minPlayers = Number(values['min-players']) || 2;

  const { unmount } = render(
    React.createElement(App, { mqttUrl, minPlayers }),
    { exitOnCtrlC: true },
  );

  process.on('SIGTERM', () => { unmount(); process.exit(0); });
}

main();
