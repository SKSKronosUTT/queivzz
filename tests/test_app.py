import re
import sqlite3
from pathlib import Path

import pytest

from app import create_app


@pytest.fixture()
def app(tmp_path):
    database = tmp_path / "queivzz-test.sqlite3"
    application = create_app(
        {
            "TESTING": True,
            "SECRET_KEY": "clave-solo-para-pruebas",
            "DATABASE": str(database),
        }
    )
    return application


@pytest.fixture()
def host(app):
    return app.test_client()


def create_room(host):
    response = host.post("/api/rooms", json={})
    assert response.status_code == 201
    data = response.get_json()
    assert data["role"] == "host"
    return data["room"]["code"], data


def join_room(client, code, name):
    return client.post("/api/rooms/join", json={"code": code, "name": name})


def start_room(host, code):
    return host.post(f"/api/rooms/{code}/start", json={})


def close_question(host, code):
    return host.post(f"/api/rooms/{code}/close-question", json={})


def score(host, code, player_id, value):
    return host.post(
        f"/api/rooms/{code}/scores",
        json={"playerId": player_id, "score": value},
    )


def answer(client, code, text, font="sans"):
    return client.post(
        f"/api/rooms/{code}/answers",
        json={"text": text, "font": font},
    )


def next_question(host, code):
    return host.post(f"/api/rooms/{code}/next", json={})


def test_creates_database_and_schema(app):
    database_path = Path(app.config["DATABASE"])
    assert database_path.exists()
    connection = sqlite3.connect(database_path)
    try:
        names = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }
    finally:
        connection.close()
    assert {"rooms", "players", "answers"}.issubset(names)


def test_host_can_create_room_with_readable_code(host):
    code, data = create_room(host)
    assert re.fullmatch(r"[A-HJ-NP-Z2-9]{6}", code)
    assert data["room"]["status"] == "lobby"
    assert data["playersCount"] == 0


def test_start_requires_at_least_one_player(host):
    code, _data = create_room(host)
    response = start_room(host, code)
    assert response.status_code == 409
    assert "jugador" in response.get_json()["error"].lower()


def test_player_can_join_with_valid_name_and_spaces_are_trimmed(host, app):
    code, _data = create_room(host)
    client = app.test_client()
    response = join_room(client, code.lower(), "  Ana  ")
    assert response.status_code == 201
    data = response.get_json()
    assert data["role"] == "player"
    assert data["me"]["name"] == "Ana"


def test_name_of_exactly_fifteen_characters_is_accepted(host, app):
    code, _data = create_room(host)
    client = app.test_client()
    response = join_room(client, code, "ABCDEFGHIJKLMNO")
    assert response.status_code == 201


def test_empty_and_too_long_names_are_rejected(app, host):
    code, _data = create_room(host)
    first = join_room(app.test_client(), code, "   ")
    second = join_room(app.test_client(), code, "ABCDEFGHIJKLMNOP")
    assert first.status_code == 400
    assert second.status_code == 400
    assert "15" in second.get_json()["error"]


def test_wrong_code_and_duplicate_name_are_rejected(host, app):
    code, _data = create_room(host)
    wrong_code = code[:-1] + ("A" if code[-1] != "A" else "B")
    missing = join_room(app.test_client(), wrong_code, "Ana")
    invalid_format = join_room(app.test_client(), "ABC", "Ana")

    first = join_room(app.test_client(), code, "Ana")
    duplicate = join_room(app.test_client(), code, "ANA")

    assert missing.status_code == 404
    assert invalid_format.status_code == 404
    assert first.status_code == 201
    assert duplicate.status_code == 409
    assert "nombre" in duplicate.get_json()["error"].lower()


def test_host_sees_new_players_in_state(host, app):
    code, _data = create_room(host)
    player_client = app.test_client()
    join_room(player_client, code, "Bruno")

    response = host.get(f"/api/rooms/{code}/state")
    assert response.status_code == 200
    data = response.get_json()
    assert data["playersCount"] == 1
    assert data["players"][0]["name"] == "Bruno"
    assert data["players"][0]["answered"] is False


def test_join_is_closed_after_start(host, app):
    code, _data = create_room(host)
    join_room(app.test_client(), code, "Ana")
    assert start_room(host, code).status_code == 200

    late_player = join_room(app.test_client(), code, "Tarde")
    assert late_player.status_code == 409
    assert "comenzó" in late_player.get_json()["error"]


def test_answer_rules_persistence_and_locking(host, app):
    code, _data = create_room(host)
    player = app.test_client()
    joined = join_room(player, code, "Ana")
    player_id = joined.get_json()["me"]["id"]

    before_start = answer(player, code, "Antes")
    assert before_start.status_code == 409

    assert start_room(host, code).status_code == 200

    submitted = answer(player, code, "  Pizza  ", "script")
    assert submitted.status_code == 200
    submitted_data = submitted.get_json()
    assert submitted_data["me"]["answer"]["confirmed"] is True
    assert submitted_data["me"]["answer"]["text"] == "Pizza"
    assert submitted_data["me"]["answer"]["font"] == "script"

    host_state = host.get(f"/api/rooms/{code}/state").get_json()
    player_card = next(
        item for item in host_state["players"] if item["id"] == player_id
    )
    assert player_card["answered"] is True

    repeated = answer(player, code, "Otra cosa")
    assert repeated.status_code == 409
    assert "confirmada" in repeated.get_json()["error"]

    assert close_question(host, code).status_code == 200
    after_close = answer(player, code, "Después")
    assert after_close.status_code == 409
    assert "cerrada" in after_close.get_json()["error"]


def test_players_cannot_use_host_actions(host, app):
    code, _data = create_room(host)
    player = app.test_client()
    joined = join_room(player, code, "Ana")
    player_id = joined.get_json()["me"]["id"]
    outsider = app.test_client()

    for client in (player, outsider):
        assert client.post(f"/api/rooms/{code}/start", json={}).status_code == 403
        assert (
            client.post(f"/api/rooms/{code}/close-question", json={}).status_code
            == 403
        )
        assert (
            client.post(
                f"/api/rooms/{code}/scores",
                json={"playerId": player_id, "score": 100},
            ).status_code
            == 403
        )
        assert client.post(f"/api/rooms/{code}/next", json={}).status_code == 403
        assert (
            client.post(f"/api/rooms/{code}/show-results", json={}).status_code
            == 403
        )


def test_only_zero_fifty_or_hundred_points_are_accepted(host, app):
    code, _data = create_room(host)
    player = app.test_client()
    player_id = join_room(player, code, "Ana").get_json()["me"]["id"]
    assert start_room(host, code).status_code == 200
    assert close_question(host, code).status_code == 200

    for invalid in (25, 75, 150, -50, "100", True):
        response = score(host, code, player_id, invalid)
        assert response.status_code == 400, invalid

    for valid in (0, 50, 100):
        assert score(host, code, player_id, valid).status_code == 200


def test_changing_a_score_updates_instead_of_duplicating(host, app):
    code, _data = create_room(host)
    player = app.test_client()
    player_id = join_room(player, code, "Ana").get_json()["me"]["id"]
    assert start_room(host, code).status_code == 200
    assert close_question(host, code).status_code == 200

    assert score(host, code, player_id, 100).status_code == 200
    changed = score(host, code, player_id, 50)
    assert changed.status_code == 200
    card = changed.get_json()["players"][0]
    assert card["score"] == 50

    connection = sqlite3.connect(app.config["DATABASE"])
    try:
        rows = connection.execute(
            "SELECT score FROM answers WHERE player_id = ? AND question_index = 0",
            (player_id,),
        ).fetchall()
    finally:
        connection.close()
    assert rows == [(50,)]


def test_next_question_waits_for_every_player_and_allows_unanswered_zero(host, app):
    code, _data = create_room(host)
    player_one = app.test_client()
    player_two = app.test_client()
    one_id = join_room(player_one, code, "Ana").get_json()["me"]["id"]
    two_id = join_room(player_two, code, "Beto").get_json()["me"]["id"]

    assert start_room(host, code).status_code == 200
    answer(player_one, code, "Pizza")
    assert close_question(host, code).status_code == 200

    assert score(host, code, one_id, 100).status_code == 200
    blocked = next_question(host, code)
    assert blocked.status_code == 409
    assert "Faltan 1" in blocked.get_json()["error"]

    assert score(host, code, two_id, 0).status_code == 200
    advanced = next_question(host, code)
    assert advanced.status_code == 200
    advanced_data = advanced.get_json()
    assert advanced_data["room"]["status"] == "question_open"
    assert advanced_data["room"]["questionIndex"] == 1


def test_close_question_is_idempotent(host, app):
    code, _data = create_room(host)
    join_room(app.test_client(), code, "Ana")
    assert start_room(host, code).status_code == 200
    first = close_question(host, code)
    second = close_question(host, code)
    assert first.status_code == 200
    assert second.status_code == 200
    assert second.get_json()["room"]["status"] == "scoring"


def test_full_game_waiting_and_results(host, app):
    code, _data = create_room(host)
    player_one = app.test_client()
    player_two = app.test_client()
    one_id = join_room(player_one, code, "Ana").get_json()["me"]["id"]
    two_id = join_room(player_two, code, "Beto").get_json()["me"]["id"]

    assert start_room(host, code).status_code == 200

    total_questions = host.get(f"/api/rooms/{code}/state").get_json()["room"][
        "totalQuestions"
    ]
    for number in range(total_questions):
        assert answer(player_one, code, f"Respuesta A{number}").status_code == 200
        if number != 0:
            assert answer(player_two, code, f"Respuesta B{number}").status_code == 200

        assert close_question(host, code).status_code == 200
        assert score(host, code, one_id, 100).status_code == 200
        assert score(host, code, two_id, 0 if number == 0 else 50).status_code == 200

        advanced = next_question(host, code)
        assert advanced.status_code == 200
        data = advanced.get_json()
        if number < total_questions - 1:
            assert data["room"]["status"] == "question_open"
        else:
            assert data["room"]["status"] == "waiting_results"

    waiting_player = player_one.get(f"/api/rooms/{code}/state")
    assert waiting_player.status_code == 200
    waiting_data = waiting_player.get_json()
    assert waiting_data["room"]["status"] == "waiting_results"
    assert "leaderboard" not in waiting_data

    waiting_host = host.get(f"/api/rooms/{code}/state").get_json()
    assert waiting_host["leaderboard"][0]["name"] == "Ana"
    assert waiting_host["leaderboard"][0]["total"] == total_questions * 100
    assert waiting_host["leaderboard"][1]["name"] == "Beto"
    assert waiting_host["leaderboard"][1]["total"] == (total_questions - 1) * 50

    assert (
        host.post(f"/api/rooms/{code}/show-results", json={}).status_code == 200
    )

    results = player_two.get(f"/api/rooms/{code}/state")
    assert results.status_code == 200
    results_data = results.get_json()
    assert results_data["room"]["status"] == "results"
    assert results_data["leaderboard"][0]["position"] == 1
    assert results_data["leaderboard"][1]["position"] == 2
    assert results_data["leaderboard"][0]["name"] == "Ana"


def test_tied_scores_share_position_and_sort_alphabetically(host, app):
    code, _data = create_room(host)
    players = ["Zoe", "Ana", "Luis"]
    for name in players:
        join_room(app.test_client(), code, name)

    connection = sqlite3.connect(app.config["DATABASE"])
    connection.row_factory = sqlite3.Row
    try:
        room = connection.execute(
            "SELECT id FROM rooms WHERE code = ?", (code,)
        ).fetchone()
        rows = connection.execute(
            "SELECT id FROM players WHERE room_id = ?", (room["id"],)
        ).fetchall()
        for row in rows:
            connection.execute(
                """
                INSERT INTO answers
                    (room_id, player_id, question_index, text, font, confirmed, score)
                VALUES (?, ?, 0, 'Igual', 'sans', 1, 100)
                """,
                (room["id"], row["id"]),
            )
        connection.execute(
            "UPDATE rooms SET status = 'waiting_results' WHERE id = ?", (room["id"],)
        )
        connection.commit()
    finally:
        connection.close()

    assert (
        host.post(f"/api/rooms/{code}/show-results", json={}).status_code == 200
    )
    data = host.get(f"/api/rooms/{code}/state").get_json()
    leaderboard = data["leaderboard"]
    assert [row["position"] for row in leaderboard] == [1, 1, 1]
    assert [row["name"] for row in leaderboard] == ["Ana", "Luis", "Zoe"]


def test_state_responses_do_not_expose_tokens(host, app):
    code, create_data = create_room(host)
    serialized_create = str(create_data).lower()
    assert "token" not in serialized_create
    assert "hash" not in serialized_create

    player = app.test_client()
    joined = join_room(player, code, "Ana")
    serialized_join = str(joined.get_json()).lower()
    assert "token" not in serialized_join
    assert "hash" not in serialized_join
    assert "secret" not in serialized_join
