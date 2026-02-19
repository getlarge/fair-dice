'use strict';

import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function openDb(dbPath) {
  ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS lobby (
      game_id TEXT PRIMARY KEY,
      lobby_json TEXT NOT NULL,
      host_fp TEXT NOT NULL,
      beacon_source TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS join_envelopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      hand_id TEXT NOT NULL,
      player_fp TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      ts TEXT NOT NULL,
      UNIQUE(game_id, hand_id, player_fp)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS reveal_envelopes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      hand_id TEXT NOT NULL,
      player_fp TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      ts TEXT NOT NULL,
      UNIQUE(game_id, hand_id, player_fp)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS hands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      hand_id TEXT NOT NULL,
      beacon_round TEXT,
      proof_json TEXT NOT NULL,
      proof_sig TEXT NOT NULL,
      host_fp TEXT NOT NULL,
      ts TEXT NOT NULL,
      UNIQUE(game_id, hand_id)
    ) STRICT;
  `);

  // append-only triggers
  ['join_envelopes', 'reveal_envelopes', 'hands'].forEach(table => {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_no_update BEFORE UPDATE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, 'append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS ${table}_no_delete BEFORE DELETE ON ${table}
      BEGIN
        SELECT RAISE(ABORT, 'append-only');
      END;
    `);
  });

  return db;
}

function defaultDbPath() {
  return path.join(process.cwd(), '.fair-dice', 'cee-lo', 'host.db');
}

export {
  openDb,
  defaultDbPath,
};
