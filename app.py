"""Queivzz: SPA de preguntas y respuestas para jugar en grupo.

El servidor es la fuente de verdad. Toda la partida vive en SQLite y el
navegador se sincroniza mediante polling HTTP (compatible con PythonAnywhere).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
from pathlib import Path

from flask import (
    Blueprint,
    Flask,
    current_app,
    jsonify,
    render_template,
    request,
    session,
)
from werkzeug.exceptions import HTTPException

from config import DEV_SECRET_KEY, Config
from database import get_db, init_app, transaction

CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_RE = re.compile(r"^[A-HJ-NP-Z2-9]{6}$")
FONT_OPTIONS = ("sans", "serif", "mono", "script")
ALLOWED_SCORES = (0, 50, 100)
MAX_NAME_LENGTH = 15
MAX_ANSWER_LENGTH = 500
HOST_TOKENS_KEY = "qz_host_tokens"
PLAYER_TOKENS_KEY = "qz_player_tokens"

main = Blueprint("main", __name__)


class ApiError(Exception):
    """Error de negocio con un mensaje legible para la SPA."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


@main.errorhandler(ApiError)
def handle_api_error(error: ApiError):
    return jsonify({"error": error.message}), error.status


def load_questions() -> list[str]:
    questions_path = Path(__file__).resolve().parent / "data" / "questions.json"
    try:
        raw = json.loads(questions_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise RuntimeError("No se encontró data/questions.json.") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError("data/questions.json no contiene JSON válido.") from exc

    if not isinstance(raw, list) or not raw:
        raise RuntimeError("data/questions.json debe contener una lista con preguntas.")

    questions: list[str] = []
    for item in raw:
        if isinstance(item, str):
            text = item
        elif isinstance(item, dict) and isinstance(item.get("text"), str):
            text = item["text"]
        else:
            raise RuntimeError(
                "Cada pregunta debe ser un texto o un objeto con la clave 'text'."
            )
        if not text.strip():
            raise RuntimeError("Las preguntas no pueden estar vacías.")
        questions.append(text)
    return questions


def new_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def token_matches(token: str, stored_hash: str) -> bool:
    return hmac.compare_digest(hash_token(token), stored_hash)


def normalize_code(value) -> str:
    if not isinstance(value, str):
        return ""
    return value.strip().upper()


def remember_token(session_key: str, code: str, token: str) -> None:
    tokens = dict(session.get(session_key, {}))
    tokens[code] = token
    session[session_key] = tokens
    session.permanent = True


def session_token(session_key: str, code: str):
    tokens = session.get(session_key) or {}
    token = tokens.get(code)
    return token if isinstance(token, str) else None


def get_room_by_code(code: str):
    if not CODE_RE.fullmatch(code):
        return None
    return get_db().execute("SELECT * FROM rooms WHERE code = ?", (code,)).fetchone()


def get_room_by_id(room_id: int):
    return get_db().execute("SELECT * FROM rooms WHERE id = ?", (room_id,)).fetchone()


def resolve_access(room):
    """Devuelve ('host'|'player'|None, fila_de_jugador|None) sin exponer tokens."""
    code = room["code"]
    host_token = session_token(HOST_TOKENS_KEY, code)
    if host_token and token_matches(host_token, room["host_token_hash"]):
        return "host", None

    player_token = session_token(PLAYER_TOKENS_KEY, code)
    if player_token:
        player = get_db().execute(
            "SELECT * FROM players WHERE room_id = ? AND token_hash = ?",
            (room["id"], hash_token(player_token)),
        ).fetchone()
        if player is not None:
            return "player", player
    return None, None


def require_host(room) -> None:
    role, _player = resolve_access(room)
    if role != "host":
        raise ApiError("Solo el anfitrión puede realizar esta acción.", 403)


def require_player(room):
    role, player = resolve_access(room)
    if role != "player" or player is None:
        raise ApiError("Solo un jugador de esta sala puede realizar esta acción.", 403)
    return player


def build_leaderboard(room) -> list[dict]:
    rows = get_db().execute(
        """
        SELECT p.id, p.name, p.name_key, COALESCE(SUM(a.score), 0) AS total
        FROM players p
        LEFT JOIN answers a
            ON a.player_id = p.id
            AND a.room_id = p.room_id
            AND a.score IS NOT NULL
        WHERE p.room_id = ?
        GROUP BY p.id, p.name, p.name_key
        ORDER BY total DESC, p.name_key ASC, p.id ASC
        """,
        (room["id"],),
    ).fetchall()

    leaderboard: list[dict] = []
    previous_total = None
    position = 0
    for index, row in enumerate(rows):
        if previous_total is None or row["total"] != previous_total:
            position = index + 1
            previous_total = row["total"]
        leaderboard.append(
            {
                "id": row["id"],
                "name": row["name"],
                "total": row["total"],
                "position": position,
            }
        )
    return leaderboard


def build_state(room, role: str, player=None) -> dict:
    db = get_db()
    questions = current_app.config["QUESTIONS"]
    total_questions = len(questions)
    status = room["status"]
    index = room["question_index"]
    question = None
    if status != "lobby" and 0 <= index < total_questions:
        question = {
            "index": index,
            "number": index + 1,
            "text": questions[index],
        }

    players_count = db.execute(
        "SELECT COUNT(*) AS total FROM players WHERE room_id = ?", (room["id"],)
    ).fetchone()["total"]

    state = {
        "role": role,
        "room": {
            "code": room["code"],
            "status": status,
            "questionIndex": index,
            "totalQuestions": total_questions,
        },
        "question": question,
        "playersCount": players_count,
    }

    if role == "host":
        if status in ("lobby", "question_open", "scoring"):
            if status == "lobby":
                rows = db.execute(
                    """
                    SELECT p.id, p.name, p.joined_at,
                           0 AS confirmed, NULL AS text, NULL AS score
                    FROM players p
                    WHERE p.room_id = ?
                    ORDER BY p.joined_at ASC, p.id ASC
                    """,
                    (room["id"],),
                ).fetchall()
            else:
                rows = db.execute(
                    """
                    SELECT p.id, p.name, p.joined_at,
                           COALESCE(a.confirmed, 0) AS confirmed,
                           a.text AS text,
                           a.score AS score
                    FROM players p
                    LEFT JOIN answers a
                        ON a.player_id = p.id AND a.question_index = ?
                    WHERE p.room_id = ?
                    ORDER BY p.joined_at ASC, p.id ASC
                    """,
                    (index, room["id"]),
                ).fetchall()

            players = []
            answered_count = 0
            scored_count = 0
            for row in rows:
                answered = bool(row["confirmed"])
                score = row["score"]
                if answered:
                    answered_count += 1
                if score is not None:
                    scored_count += 1
                answer_text = row["text"] if status == "scoring" and answered else None
                players.append(
                    {
                        "id": row["id"],
                        "name": row["name"],
                        "answered": answered,
                        "answerText": answer_text,
                        "score": score,
                    }
                )
            state["players"] = players
            state["progress"] = {
                "answered": answered_count,
                "scored": scored_count,
                "total": players_count,
                "remaining": max(players_count - scored_count, 0),
            }

        if status in ("waiting_results", "results"):
            state["leaderboard"] = build_leaderboard(room)

    elif role == "player" and player is not None:
        state["me"] = {"id": player["id"], "name": player["name"], "answer": None}
        if status in ("question_open", "scoring", "waiting_results", "results"):
            answer = db.execute(
                """
                SELECT text, font, confirmed, score
                FROM answers
                WHERE player_id = ? AND question_index = ?
                """,
                (player["id"], index),
            ).fetchone()
            if answer is not None and answer["confirmed"]:
                state["me"]["answer"] = {
                    "text": answer["text"],
                    "font": answer["font"],
                    "confirmed": True,
                }
        if status == "results":
            state["leaderboard"] = build_leaderboard(room)

    return state


def current_host_state(room_id: int):
    room = get_room_by_id(room_id)
    return build_state(room, "host")


def current_player_state(room_id: int, player):
    room = get_room_by_id(room_id)
    return build_state(room, "player", player)


def json_payload() -> dict:
    payload = request.get_json(silent=True)
    if payload is None:
        return {}
    if not isinstance(payload, dict):
        raise ApiError("El cuerpo de la petición debe ser un objeto JSON.", 400)
    return payload


@main.get("/")
def index():
    return render_template("index.html")


@main.post("/api/rooms")
def create_room():
    token = new_token()
    token_digest = hash_token(token)

    with transaction() as db:
        code = ""
        for _attempt in range(30):
            candidate = "".join(secrets.choice(CODE_ALPHABET) for _ in range(6))
            exists = db.execute(
                "SELECT 1 FROM rooms WHERE code = ?", (candidate,)
            ).fetchone()
            if exists is None:
                code = candidate
                break
        if not code:
            raise ApiError("No se pudo generar un código de sala. Inténtalo de nuevo.", 503)

        cursor = db.execute(
            "INSERT INTO rooms (code, status, question_index, host_token_hash) VALUES (?, 'lobby', 0, ?)",
            (code, token_digest),
        )
        room_id = cursor.lastrowid

    remember_token(HOST_TOKENS_KEY, code, token)
    return jsonify(current_host_state(room_id)), 201


@main.post("/api/rooms/join")
def join_room():
    payload = json_payload()
    code = normalize_code(payload.get("code"))
    raw_name = payload.get("name")

    if not isinstance(raw_name, str):
        raise ApiError("Escribe tu nombre para entrar.", 400)
    name = raw_name.strip()
    if not name:
        raise ApiError("Escribe tu nombre para entrar.", 400)
    if len(name) > MAX_NAME_LENGTH:
        raise ApiError("El nombre no puede tener más de 15 caracteres.", 400)
    if any(ord(character) < 32 for character in name):
        raise ApiError("El nombre contiene caracteres no permitidos.", 400)

    room = get_room_by_code(code)
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)

    role, existing_player = resolve_access(room)
    if role == "host":
        raise ApiError("Eres el anfitrión de esta sala; no puedes unirte como jugador.", 409)
    if role == "player" and existing_player is not None:
        return jsonify(build_state(room, "player", existing_player)), 200

    if room["status"] != "lobby":
        raise ApiError("La partida ya comenzó. No es posible unirse ahora.", 409)

    name_key = name.casefold()
    token = new_token()
    token_digest = hash_token(token)

    with transaction() as db:
        fresh_room = db.execute(
            "SELECT * FROM rooms WHERE id = ?", (room["id"],)
        ).fetchone()
        if fresh_room is None:
            raise ApiError("No existe una sala con ese código.", 404)
        if fresh_room["status"] != "lobby":
            raise ApiError("La partida ya comenzó. No es posible unirse ahora.", 409)

        duplicate = db.execute(
            "SELECT 1 FROM players WHERE room_id = ? AND name_key = ?",
            (fresh_room["id"], name_key),
        ).fetchone()
        if duplicate is not None:
            raise ApiError("Ese nombre ya está en uso en esta sala. Elige otro.", 409)

        try:
            cursor = db.execute(
                """
                INSERT INTO players (room_id, name, name_key, token_hash)
                VALUES (?, ?, ?, ?)
                """,
                (fresh_room["id"], name, name_key, token_digest),
            )
        except sqlite3.IntegrityError as exc:
            raise ApiError(
                "Ese nombre ya está en uso en esta sala. Elige otro.", 409
            ) from exc
        player_id = cursor.lastrowid

    remember_token(PLAYER_TOKENS_KEY, code, token)
    player = get_db().execute("SELECT * FROM players WHERE id = ?", (player_id,)).fetchone()
    room = get_room_by_id(room["id"])
    return jsonify(build_state(room, "player", player)), 201


@main.get("/api/rooms/<code>/state")
def room_state(code: str):
    room = get_room_by_code(normalize_code(code))
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)

    role, player = resolve_access(room)
    if role is None:
        raise ApiError("No tienes acceso a esta sala desde este navegador.", 403)

    if role == "player" and player is not None:
        get_db().execute(
            "UPDATE players SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
            (player["id"],),
        )
    return jsonify(build_state(room, role, player))


@main.post("/api/rooms/<code>/start")
def start_room(code: str):
    room = get_room_by_code(normalize_code(code))
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)
    require_host(room)

    with transaction() as db:
        fresh = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if fresh["status"] == "question_open" and fresh["question_index"] == 0:
            pass
        elif fresh["status"] != "lobby":
            raise ApiError("La partida ya fue iniciada.", 409)
        else:
            count = db.execute(
                "SELECT COUNT(*) AS total FROM players WHERE room_id = ?", (fresh["id"],)
            ).fetchone()["total"]
            if count < 1:
                raise ApiError("Invita al menos a un jugador antes de iniciar.", 409)
            db.execute(
                """
                UPDATE rooms
                SET status = 'question_open', question_index = 0,
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND status = 'lobby'
                """,
                (fresh["id"],),
            )
    return jsonify(current_host_state(room["id"]))


@main.post("/api/rooms/<code>/answers")
def submit_answer(code: str):
    room = get_room_by_code(normalize_code(code))
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)
    player = require_player(room)

    payload = json_payload()
    raw_text = payload.get("text")
    font = payload.get("font", "sans")
    if not isinstance(raw_text, str):
        raise ApiError("Escribe una respuesta antes de confirmar.", 400)
    text = raw_text.strip()
    if not text:
        raise ApiError("Escribe una respuesta antes de confirmar.", 400)
    if len(text) > MAX_ANSWER_LENGTH:
        raise ApiError("La respuesta es demasiado larga (máximo 500 caracteres).", 400)
    if font not in FONT_OPTIONS:
        font = "sans"

    with transaction() as db:
        fresh = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if fresh is None:
            raise ApiError("No existe una sala con ese código.", 404)
        if fresh["status"] != "question_open":
            raise ApiError("La pregunta está cerrada. No se aceptan más respuestas.", 409)

        question_index = fresh["question_index"]
        existing = db.execute(
            "SELECT confirmed FROM answers WHERE player_id = ? AND question_index = ?",
            (player["id"], question_index),
        ).fetchone()
        if existing is not None and existing["confirmed"]:
            raise ApiError("Tu respuesta ya fue confirmada y no se puede cambiar.", 409)

        db.execute(
            """
            INSERT INTO answers
                (room_id, player_id, question_index, text, font, confirmed, score, updated_at)
            VALUES (?, ?, ?, ?, ?, 1, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT (player_id, question_index) DO UPDATE SET
                text = excluded.text,
                font = excluded.font,
                confirmed = 1,
                updated_at = excluded.updated_at
            """,
            (fresh["id"], player["id"], question_index, text, font),
        )

    fresh_player = get_db().execute(
        "SELECT * FROM players WHERE id = ?", (player["id"],)
    ).fetchone()
    return jsonify(current_player_state(room["id"], fresh_player))


@main.post("/api/rooms/<code>/close-question")
def close_question(code: str):
    room = get_room_by_code(normalize_code(code))
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)
    require_host(room)

    with transaction() as db:
        fresh = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if fresh["status"] == "question_open":
            db.execute(
                """
                UPDATE rooms
                SET status = 'scoring',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND status = 'question_open'
                """,
                (fresh["id"],),
            )
        elif fresh["status"] != "scoring":
            raise ApiError("No hay una pregunta abierta para cerrar.", 409)
    return jsonify(current_host_state(room["id"]))


@main.post("/api/rooms/<code>/scores")
def assign_score(code: str):
    room = get_room_by_code(normalize_code(code))
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)
    require_host(room)

    payload = json_payload()
    player_id = payload.get("playerId")
    score = payload.get("score")
    if isinstance(player_id, bool) or not isinstance(player_id, int):
        raise ApiError("Jugador no válido.", 400)
    if isinstance(score, bool) or not isinstance(score, int) or score not in ALLOWED_SCORES:
        raise ApiError("La puntuación solo puede ser 0, 50 o 100.", 400)

    with transaction() as db:
        fresh = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if fresh["status"] != "scoring":
            raise ApiError("Solo se puede puntuar mientras la pregunta está cerrada.", 409)

        player = db.execute(
            "SELECT id FROM players WHERE id = ? AND room_id = ?",
            (player_id, fresh["id"]),
        ).fetchone()
        if player is None:
            raise ApiError("Jugador no encontrado en esta sala.", 404)

        db.execute(
            """
            INSERT INTO answers
                (room_id, player_id, question_index, text, font, confirmed, score, updated_at)
            VALUES (?, ?, ?, '', 'sans', 0, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            ON CONFLICT (player_id, question_index) DO UPDATE SET
                score = excluded.score,
                updated_at = excluded.updated_at
            """,
            (fresh["id"], player_id, fresh["question_index"], score),
        )
    return jsonify(current_host_state(room["id"]))


@main.post("/api/rooms/<code>/next")
def next_question(code: str):
    room = get_room_by_code(normalize_code(code))
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)
    require_host(room)

    total_questions = len(current_app.config["QUESTIONS"])

    with transaction() as db:
        fresh = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if fresh["status"] != "scoring":
            raise ApiError("Primero debes cerrar y puntuar la pregunta actual.", 409)

        index = fresh["question_index"]
        stats = db.execute(
            """
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN a.score IS NOT NULL THEN 1 ELSE 0 END) AS scored
            FROM players p
            LEFT JOIN answers a
                ON a.player_id = p.id AND a.question_index = ?
            WHERE p.room_id = ?
            """,
            (index, fresh["id"]),
        ).fetchone()
        total = stats["total"] or 0
        scored = stats["scored"] or 0
        if total == 0:
            raise ApiError("No hay jugadores en la sala.", 409)
        if scored < total:
            missing = total - scored
            raise ApiError(
                f"Faltan {missing} jugador{'es' if missing != 1 else ''} por calificar.",
                409,
            )

        if index + 1 < total_questions:
            db.execute(
                """
                UPDATE rooms
                SET question_index = ?, status = 'question_open',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND status = 'scoring'
                """,
                (index + 1, fresh["id"]),
            )
        else:
            db.execute(
                """
                UPDATE rooms
                SET status = 'waiting_results',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND status = 'scoring'
                """,
                (fresh["id"],),
            )
    return jsonify(current_host_state(room["id"]))


@main.post("/api/rooms/<code>/show-results")
def show_results(code: str):
    room = get_room_by_code(normalize_code(code))
    if room is None:
        raise ApiError("No existe una sala con ese código.", 404)
    require_host(room)

    with transaction() as db:
        fresh = db.execute("SELECT * FROM rooms WHERE id = ?", (room["id"],)).fetchone()
        if fresh["status"] == "waiting_results":
            db.execute(
                """
                UPDATE rooms
                SET status = 'results',
                    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE id = ? AND status = 'waiting_results'
                """,
                (fresh["id"],),
            )
        elif fresh["status"] != "results":
            raise ApiError("Todavía no hay resultados para mostrar.", 409)
    return jsonify(current_host_state(room["id"]))


def create_app(test_config: dict | None = None) -> Flask:
    app = Flask(__name__, instance_relative_config=True)
    app.config.from_object(Config)
    if test_config:
        app.config.update(test_config)

    Path(app.instance_path).mkdir(parents=True, exist_ok=True)
    app.json.ensure_ascii = False

    if app.config.get("SECRET_KEY") == DEV_SECRET_KEY:
        app.logger.warning(
            "SECRET_KEY de desarrollo en uso. Define la variable de entorno "
            "SECRET_KEY antes de publicar la aplicación."
        )

    app.config["QUESTIONS"] = load_questions()
    init_app(app)
    app.register_blueprint(main)

    @app.after_request
    def add_security_headers(response):
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
            "font-src 'self' https://fonts.gstatic.com data:; "
            "img-src 'self' data:; "
            "connect-src 'self'; "
            "form-action 'self'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'",
        )
        if request.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(HTTPException)
    def handle_http_error(error):
        if request.path.startswith("/api/"):
            messages = {
                400: "La petición no es válida.",
                404: "No se encontró el recurso solicitado.",
                405: "Método no permitido.",
                413: "La petición es demasiado grande.",
            }
            message = messages.get(error.code, "No se pudo completar la petición.")
            return jsonify({"error": message}), error.code
        return error

    return app


if __name__ == "__main__":
    import os

    application = create_app()
    application.run(
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "5000")),
        debug=True,
    )
