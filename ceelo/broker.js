'use strict';

import aedes from 'aedes';
import http from 'http';
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws';

function startBroker({ port = 8080, host = '0.0.0.0', onPublish }) {
  const broker = aedes();
  if (onPublish) {
    broker.on('publish', (packet, client) => {
      // Ignore broker-originated retained messages at startup
      if (!client) return;
      onPublish(packet, client);
    });
  }

  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', ws => {
    const stream = createWebSocketStream(ws, { binary: true });
    broker.handle(stream);
  });

  server.listen(port, host, () => {
    console.log(`MQTT/WS broker listening on ws://${host}:${port}`);
  });

  return { broker, server, wss };
}

export { startBroker };
