"""Utilidades de conexión y transacciones de SQLite."""

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from flask import current_app, g


def get_db() -> sqlite3.Connection:
    """Devuelve la conexión SQLite de la petición actual."""
    if "db" not in g:
        database_path = Path(current_app.config["DATABASE"])
        database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(
            str(database_path),
            timeout=15,
            isolation_level=None,
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA busy_timeout = 15000")
        g.db = connection
    return g.db


def close_db(_error=None) -> None:
    connection = g.pop("db", None)
    if connection is not None:
        connection.close()


def init_db() -> None:
    """Crea el esquema si no existe. No borra datos existentes."""
    connection = get_db()
    schema_path = Path(current_app.root_path) / "schema.sql"
    schema = schema_path.read_text(encoding="utf-8")
    connection.executescript(schema)
    connection.execute("PRAGMA journal_mode = WAL")


@contextmanager
def transaction():
    """Transacción corta con bloqueo de escritura inmediato.

    ``BEGIN IMMEDIATE`` evita que dos peticiones simultáneas lean el mismo
    estado y después escriban transiciones contradictorias.
    """
    connection = get_db()
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
    except Exception:
        connection.execute("ROLLBACK")
        raise
    else:
        connection.execute("COMMIT")


def init_app(app) -> None:
    app.teardown_appcontext(close_db)
    with app.app_context():
        init_db()
