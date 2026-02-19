'use strict';

import aedes from 'aedes';
import http from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';

function startBroker({ port = 8080, host = '0.0.0.0' } = {}) {
  const broker = aedes();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', ws => {
    const stream = createWebSocketStream(ws, { binary: true });
    broker.handle(stream);
  });

  server.listen(port, host, () => {
    console.log(`MQTT/WS broker listening on ws://${host}:${server.address().port}`);
  });

  return { broker, server, wss };
}

export { startBroker };
