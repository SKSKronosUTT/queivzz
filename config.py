"""Configuración de Queivzz.

La clave secreta debe venir de la variable de entorno ``SECRET_KEY``.
La ruta de SQLite se puede cambiar con ``DATABASE_PATH`` (útil en PythonAnywhere).
"""

import os
from datetime import timedelta
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent

DEV_SECRET_KEY = "queivzz-dev-key-cambia-esto-en-produccion"


def env_flag(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    SECRET_KEY = os.environ.get("SECRET_KEY", DEV_SECRET_KEY)
    DATABASE = os.environ.get(
        "DATABASE_PATH", str(BASE_DIR / "instance" / "queivzz.sqlite3")
    )
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    SESSION_COOKIE_SECURE = env_flag("SESSION_COOKIE_SECURE", False)
    PERMANENT_SESSION_LIFETIME = timedelta(days=30)
    MAX_CONTENT_LENGTH = 64 * 1024
    JSON_SORT_KEYS = False
