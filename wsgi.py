"""Punto de entrada WSGI para PythonAnywhere y otros servidores."""

from app import create_app

application = create_app()
