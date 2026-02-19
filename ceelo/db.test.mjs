import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
  return openDb(path.join(dir, 'test.db'));
}

// ── schema ────────────────────────────────────────────────────────────────────

test('openDb creates all required tables', () => {
  const db = tempDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map(r => r.name);
  assert.ok(tables.includes('lobby'),            'lobby table');
  assert.ok(tables.includes('join_envelopes'),   'join_envelopes table');
  assert.ok(tables.includes('reveal_envelopes'), 'reveal_envelopes table');
  assert.ok(tables.includes('hands'),            'hands table');
});

test('openDb is idempotent — second call on same file does not throw', () => {
  const dir     = fs.mkdtempSync(path.join(os.tmpdir(), 'db-test-'));
  const dbPath  = path.join(dir, 'idempotent.db');
  assert.doesNotThrow(() => openDb(dbPath));
  assert.doesNotThrow(() => openDb(dbPath));
});

// ── lobby ─────────────────────────────────────────────────────────────────────

test('lobby INSERT OR REPLACE updates existing row', () => {
  const db = tempDb();
  db.prepare('INSERT OR REPLACE INTO lobby(game_id,lobby_json,host_fp,beacon_source,created_at) VALUES(?,?,?,?,?)').run('g1','{}','fp','drand','2024-01-01T00:00:00Z');
  db.prepare('INSERT OR REPLACE INTO lobby(game_id,lobby_json,host_fp,beacon_source,created_at) VALUES(?,?,?,?,?)').run('g1','{"updated":true}','fp2','test','2024-01-02T00:00:00Z');
  const row = db.prepare('SELECT * FROM lobby WHERE game_id=?').get('g1');
  assert.equal(JSON.parse(row.lobby_json).updated, true);
  assert.equal(db.prepare('SELECT count(*) as n FROM lobby').get().n, 1, 'still one row');
});

// ── join_envelopes ────────────────────────────────────────────────────────────

test('join_envelopes INSERT OR IGNORE deduplicates same (game,hand,player)', () => {
  const db = tempDb();
  const insert = db.prepare('INSERT OR IGNORE INTO join_envelopes(game_id,hand_id,player_fp,envelope_json,ts) VALUES(?,?,?,?,?)');
  insert.run('g1','h1','fp1','{"first":true}','2024-01-01T00:00:00Z');
  insert.run('g1','h1','fp1','{"second":true}','2024-01-02T00:00:00Z'); // same PK — ignored
  const rows = db.prepare('SELECT * FROM join_envelopes WHERE game_id=?').all('g1');
  assert.equal(rows.length, 1, 'only one row');
  assert.equal(JSON.parse(rows[0].envelope_json).first, true, 'first write preserved');
});

test('join_envelopes allows different players in same hand', () => {
  const db = tempDb();
  const insert = db.prepare('INSERT OR IGNORE INTO join_envelopes(game_id,hand_id,player_fp,envelope_json,ts) VALUES(?,?,?,?,?)');
  insert.run('g1','h1','fp1','{}','2024-01-01T00:00:00Z');
  insert.run('g1','h1','fp2','{}','2024-01-01T00:00:00Z');
  const count = db.prepare('SELECT count(*) as n FROM join_envelopes').get().n;
  assert.equal(count, 2);
});

// ── append-only triggers ──────────────────────────────────────────────────────

test('join_envelopes UPDATE is rejected by trigger', () => {
  const db = tempDb();
  db.prepare('INSERT INTO join_envelopes(game_id,hand_id,player_fp,envelope_json,ts) VALUES(?,?,?,?,?)').run('g1','h1','fp1','{}','2024-01-01T00:00:00Z');
  assert.throws(
    () => db.prepare('UPDATE join_envelopes SET envelope_json=? WHERE game_id=?').run('{"mutated":true}','g1'),
    /append-only/,
  );
});

test('join_envelopes DELETE is rejected by trigger', () => {
  const db = tempDb();
  db.prepare('INSERT INTO join_envelopes(game_id,hand_id,player_fp,envelope_json,ts) VALUES(?,?,?,?,?)').run('g1','h1','fp1','{}','2024-01-01T00:00:00Z');
  assert.throws(
    () => db.prepare('DELETE FROM join_envelopes WHERE game_id=?').run('g1'),
    /append-only/,
  );
});

test('reveal_envelopes UPDATE is rejected by trigger', () => {
  const db = tempDb();
  db.prepare('INSERT INTO reveal_envelopes(game_id,hand_id,player_fp,envelope_json,ts) VALUES(?,?,?,?,?)').run('g1','h1','fp1','{}','2024-01-01T00:00:00Z');
  assert.throws(
    () => db.prepare('UPDATE reveal_envelopes SET envelope_json=? WHERE game_id=?').run('{}','g1'),
    /append-only/,
  );
});

test('reveal_envelopes DELETE is rejected by trigger', () => {
  const db = tempDb();
  db.prepare('INSERT INTO reveal_envelopes(game_id,hand_id,player_fp,envelope_json,ts) VALUES(?,?,?,?,?)').run('g1','h1','fp1','{}','2024-01-01T00:00:00Z');
  assert.throws(
    () => db.prepare('DELETE FROM reveal_envelopes WHERE game_id=?').run('g1'),
    /append-only/,
  );
});

test('hands UPDATE is rejected by trigger', () => {
  const db = tempDb();
  db.prepare('INSERT INTO hands(game_id,hand_id,beacon_round,proof_json,proof_sig,host_fp,ts) VALUES(?,?,?,?,?,?,?)').run('g1','h1','b','{}','sig','fp','2024-01-01T00:00:00Z');
  assert.throws(
    () => db.prepare('UPDATE hands SET proof_json=? WHERE game_id=?').run('{}','g1'),
    /append-only/,
  );
});

test('hands DELETE is rejected by trigger', () => {
  const db = tempDb();
  db.prepare('INSERT INTO hands(game_id,hand_id,beacon_round,proof_json,proof_sig,host_fp,ts) VALUES(?,?,?,?,?,?,?)').run('g1','h1','b','{}','sig','fp','2024-01-01T00:00:00Z');
  assert.throws(
    () => db.prepare('DELETE FROM hands WHERE game_id=?').run('g1'),
    /append-only/,
  );
});

// ── hands UNIQUE constraint ───────────────────────────────────────────────────

test('hands UNIQUE(game_id, hand_id) prevents double-finalization', () => {
  const db = tempDb();
  const insert = db.prepare('INSERT OR IGNORE INTO hands(game_id,hand_id,beacon_round,proof_json,proof_sig,host_fp,ts) VALUES(?,?,?,?,?,?,?)');
  insert.run('g1','h1','b','{"first":true}','sig','fp','2024-01-01T00:00:00Z');
  insert.run('g1','h1','b','{"second":true}','sig2','fp','2024-01-02T00:00:00Z'); // OR IGNORE
  const row = db.prepare('SELECT * FROM hands WHERE game_id=? AND hand_id=?').get('g1','h1');
  assert.equal(JSON.parse(row.proof_json).first, true, 'first proof preserved');
});
