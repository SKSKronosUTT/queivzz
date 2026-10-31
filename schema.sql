-- Esquema de Queivzz. Se ejecuta de forma idempotente al arrancar la app.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'lobby'
        CHECK (status IN ('lobby', 'question_open', 'scoring', 'waiting_results', 'results')),
    question_index INTEGER NOT NULL DEFAULT 0 CHECK (question_index >= 0),
    host_token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (room_id, name_key)
);

CREATE TABLE IF NOT EXISTS answers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    question_index INTEGER NOT NULL CHECK (question_index >= 0),
    text TEXT NOT NULL DEFAULT '',
    font TEXT NOT NULL DEFAULT 'sans'
        CHECK (font IN ('sans', 'serif', 'mono', 'script')),
    confirmed INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0, 1)),
    score INTEGER CHECK (score IS NULL OR score IN (0, 50, 100)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (player_id, question_index)
);

CREATE INDEX IF NOT EXISTS idx_players_room ON players (room_id);
CREATE INDEX IF NOT EXISTS idx_answers_room_question ON answers (room_id, question_index);
CREATE INDEX IF NOT EXISTS idx_answers_player_question ON answers (player_id, question_index);
