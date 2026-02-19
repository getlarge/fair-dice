'use strict';

import { useState, useEffect, useRef } from 'react';
import mqtt from 'mqtt';

// ─────────────────────────────────────────────────────────────────────────────
// useMqtt — connects to the broker, subscribes to cee-lo/# wildcard,
// calls onMessage(topic, parsed) for every incoming packet.
// Returns { connected, publish }.
// ─────────────────────────────────────────────────────────────────────────────

export function useMqtt({ mqttUrl, onMessage }) {
  const [connected, setConnected] = useState(false);
  const clientRef = useRef(null);

  useEffect(() => {
    const client = mqtt.connect(mqttUrl, {
      protocolVersion: 4,
      connectTimeout: 5000,
      reconnectPeriod: 2000,
    });
    clientRef.current = client;

    client.on('connect', () => {
      setConnected(true);
      client.subscribe('cee-lo/#', { qos: 1 });
    });

    client.on('reconnect', () => setConnected(false));
    client.on('offline',   () => setConnected(false));
    client.on('error',     () => setConnected(false));

    client.on('message', (topic, buf) => {
      try {
        const payload = JSON.parse(buf.toString('utf8'));
        onMessage(topic, payload);
      } catch {
        // non-JSON message — ignore
      }
    });

    return () => {
      client.end(true);
    };
  }, [mqttUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  function publish(topic, payload, opts = { qos: 1 }) {
    return new Promise((resolve, reject) => {
      if (!clientRef.current) return reject(new Error('not connected'));
      clientRef.current.publish(topic, JSON.stringify(payload), opts, err =>
        err ? reject(err) : resolve(),
      );
    });
  }

  return { connected, publish };
}
