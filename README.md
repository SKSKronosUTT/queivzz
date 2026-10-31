# Queivzz

**Queivzz** es una Single Page Application (SPA) de preguntas y respuestas para jugar en grupo. Una persona actúa como anfitrión desde su computadora, comparte un código de sala y sus amigos responden desde el móvil. Las respuestas se escriben libremente y el anfitrión asigna manualmente 0, 50 o 100 puntos a cada una.

La aplicación está pensada para **móvil vertical**, y se adapta también a móvil horizontal y escritorio. La interfaz está en español, con una dirección visual tipo hoja de trabajo dibujada a mano (“Sketch”) y cinco paletas de color que cada navegador guarda por separado.

## Funciones principales

- Crear una sala con código de 6 caracteres fácil de leer.
- Compartir el código o un enlace de invitación con `?room=CODIGO`.
- Unirse con un nombre de hasta 15 caracteres, sin duplicados dentro de la sala.
- Sala de espera con actualización automática por *polling* HTTP.
- Preguntas con la primera palabra en grande y el resto debajo.
- Pizarrón de respuesta amplio, con cuatro tipografías conmutables.
- Confirmación de respuesta con bloqueo posterior.
- Vista del anfitrión con estado de respuestas, cierre de pregunta y puntuación manual.
- Puntuaciones exclusivas de `0`, `50` y `100`, sin duplicar puntos al corregir.
- Espera de resultados con animación y revelación final de la clasificación.
- Oro, plata y bronce para los tres primeros puestos.
- Cinco paletas: Main, Pizza, XB, Amazon y ABDA.
- Persistencia en SQLite; sin WebSockets, Redis ni procesos adicionales.

## Tecnologías

- Python con Flask.
- SQLite.
- HTML, CSS y JavaScript vanilla.
- Plantillas Jinja para servir `index.html`.
- Comunicación JSON mediante `fetch()` y *polling* HTTP.

No usa React, Vue, Angular, TypeScript, Node.js ni compilación de frontend. Tampoco usa Flask-SocketIO.

## Requisitos

- Python 3.10 o superior recomendado (Flask 3.1 requiere Python 3.9+).
- `pip` y capacidad para crear un entorno virtual.
- Navegador moderno con JavaScript activado.
- Para pruebas: `pytest` (está en `requirements-dev.txt`).

## Instalación y ejecución local

Desde la carpeta del proyecto:

```bash
cd Queivzz
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Configura una clave secreta real para desarrollo:

```bash
export SECRET_KEY="$(python -c 'import secrets; print(secrets.token_hex(32))')"
```

Ejecuta la aplicación:

```bash
python app.py
```

También puedes usar el servidor de desarrollo de Flask:

```bash
flask --app wsgi run --debug
```

Abre `http://127.0.0.1:5000` en el navegador.

Para probar con un anfitrión y dos jugadores en el mismo equipo, usa **ventanas normales e incógnito o navegadores distintos**, porque la identidad de cada rol se guarda en una cookie de sesión del navegador.

La base de datos se crea automáticamente en `instance/queivzz.sqlite3` la primera vez que arranca la aplicación. La carpeta `instance/` no es pública y está excluida de Git.

### Variables de entorno

Puedes partir de `.env.example`:

```bash
cp .env.example .env
set -a
source .env
set +a
```

Variables disponibles:

| Variable | Uso |
| --- | --- |
| `SECRET_KEY` | Clave para firmar las cookies de sesión. **Obligatoria en producción.** |
| `DATABASE_PATH` | Ruta opcional del archivo SQLite. Por defecto `instance/queivzz.sqlite3`. |
| `SESSION_COOKIE_SECURE` | `1` para exigir HTTPS en la cookie de sesión. En local por HTTP debe quedar en `0`. |
| `PORT` | Solo para `python app.py`; por defecto `5000`. |

La aplicación **no carga `.env` automáticamente** para no añadir dependencias; cárgalo con `source`/tu gestor de procesos o define las variables en el entorno. Si se omite `SECRET_KEY`, se usa una clave de desarrollo y el servidor muestra una advertencia en el log. No uses esa clave en producción.

## Cómo ejecutar las pruebas

```bash
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -q
```

Las pruebas usan una base de datos temporal por prueba y no tocan `instance/queivzz.sqlite3`.

Cubren, entre otros casos:

- creación automática de SQLite y esquema;
- formato del código de sala;
- nombres válidos, recorte de espacios, vacío y longitud máxima;
- código incorrecto y nombre duplicado sin distinguir mayúsculas;
- ingreso de jugadores visible para el anfitrión;
- respuesta antes de iniciar y después de cerrar;
- persistencia y bloqueo de la respuesta confirmada;
- permisos: un jugador o un visitante no pueden ejecutar acciones de anfitrión;
- puntuaciones solo `0`, `50` o `100`;
- avance bloqueado hasta calificar a todos;
- corrección de puntuación sin filas duplicadas;
- flujo completo de todas las preguntas hasta espera y resultados;
- empates con la misma posición y orden alfabético de presentación;
- respuestas JSON sin tokens ni hashes.

## Cómo editar las preguntas

Las preguntas están en `data/questions.json` como una lista de textos, en el orden en que aparecerán:

```json
[
  "Comida que le guste al Caves",
  "Bebida que le guste al Caves"
]
```

- Añade una línea nueva para agregar una pregunta.
- Quita o reordena líneas para cambiar la actividad.
- Mantén el archivo como JSON válido y con al menos una pregunta.
- Cada pregunta puede ser un texto o un objeto con la clave `text`, por ejemplo `{ "text": "Otra pregunta" }`.
- No es necesario tocar la lógica de la aplicación.
- **Reinicia el servidor** después de editar el archivo: las preguntas se cargan al arrancar.
- Evita editar las preguntas mientras hay una partida en curso, porque el índice actual de la sala depende de esa lista.

La interfaz separa automáticamente la primera palabra de cada pregunta para mostrarla como titular grande. No hay que escribirla en mayúsculas en el JSON; el estilo visual se encarga del formato.

## Reglas y estados de partida

Estados guardados en SQLite:

- `lobby`: se admiten jugadores; el anfitrión decide cuándo iniciar.
- `question_open`: se aceptan respuestas de la pregunta actual.
- `scoring`: la pregunta está cerrada y el anfitrión asigna puntos.
- `waiting_results`: todas las preguntas están puntuadas; los jugadores esperan.
- `results`: la tabla final está publicada para todos.

El servidor valida cada transición y cada permiso. Las acciones repetidas de cierre de pregunta son idempotentes para no romper la partida con dobles clics.

### Desempates

La clasificación se ordena por puntuación total descendente. Si dos o más jugadores tienen el mismo total, **comparten la misma posición** (estilo competición: por ejemplo, 1, 1, 3). Para presentar a los empatados se ordenan alfabéticamente por nombre normalizado y, si persiste el empate, por identificador interno. Esto solo afecta al orden visual; no altera los puntos.

## Sincronización y despliegue en PythonAnywhere

La sincronización se hace por **polling HTTP** cada 1,5 segundos aproximadamente. Cuando la pestaña está oculta, el navegador deja de consultar; al volver, retoma. Cuando la partida llega a `results`, el polling se detiene. No hay WebSockets, Flask-SocketIO, Redis ni procesos en segundo plano.

### Pasos sugeridos

1. Sube el contenido del proyecto a PythonAnywhere, por ejemplo a `/home/TUUSUARIO/Queivzz`. Puedes subir el ZIP y descomprimirlo desde una consola Bash.
2. Crea un entorno virtual e instala dependencias:

   ```bash
   cd /home/TUUSUARIO/Queivzz
   python3.10 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

   Ajusta `python3.10` a la versión disponible en tu cuenta.

3. En la pestaña **Web**, crea o configura una aplicación con **Manual configuration** y selecciona una versión de Python compatible. También puedes usar la configuración Flask, pero el archivo WSGI debe apuntar a este proyecto.
4. Configura:
   - **Source code:** `/home/TUUSUARIO/Queivzz`
   - **Working directory:** `/home/TUUSUARIO/Queivzz`
   - **Virtualenv:** `/home/TUUSUARIO/Queivzz/.venv`
5. Edita el archivo WSGI de PythonAnywhere. Debe definir `application` y configurar las variables **antes** de importar la app:

   ```python
   import os
   import sys

   path = "/home/TUUSUARIO/Queivzz"
   if path not in sys.path:
       sys.path.insert(0, path)

   os.environ["SECRET_KEY"] = "UNA-CLAVE-LARGA-Y-ALEATORIA"
   os.environ["SESSION_COOKIE_SECURE"] = "1"
   # opcional:
   # os.environ["DATABASE_PATH"] = "/home/TUUSUARIO/Queivzz/instance/queivzz.sqlite3"

   from wsgi import application
   ```

   No guardes tu clave real en un repositorio público. En PythonAnywhere, el archivo WSGI está fuera del proyecto público, pero aun así trátalo como secreto.

6. Asegura que exista y sea escribible la carpeta `instance/`:

   ```bash
   mkdir -p /home/TUUSUARIO/Queivzz/instance
   ```

   Por defecto SQLite se guarda ahí, fuera de `static/`. La base de datos se crea sola al arrancar.
7. Pulsa **Reload** en la pestaña Web y revisa los logs de error si algo falla.
8. Abre la URL HTTPS de tu aplicación. Con `SESSION_COOKIE_SECURE=1`, las cookies solo viajan por HTTPS; no uses esa opción para probar en HTTP local.

`wsgi.py` ya exporta `application = create_app()` y **no ejecuta `app.run()` al importarse**. El bloque `if __name__ == "__main__":` de `app.py` se usa únicamente para desarrollo local.

### Notas específicas de PythonAnywhere

- El plan gratuito puede mostrar una página de bienvenida hasta que pulses Reload tras cada cambio.
- Los archivos servidos desde `static/` son públicos. La base de datos no debe estar dentro de `static/`.
- SQLite con WAL funciona en el sistema de archivos de PythonAnywhere, pero no está pensado para cargas muy altas. Esta aplicación usa transacciones cortas y bloqueo inmediato para acciones críticas.
- Si cambias `data/questions.json`, recarga la aplicación.
- Si quieres reiniciar la actividad desde cero, detén la app y borra `instance/queivzz.sqlite3`, `instance/queivzz.sqlite3-wal` e `instance/queivzz.sqlite3-shm`; el esquema se recreará al arrancar. Esto borra todas las salas.

## Estructura del proyecto

```text
Queivzz/
├── app.py                  # Fábrica de la app, API y lógica de partida
├── config.py               # Configuración y variables de entorno
├── database.py             # Conexión SQLite y transacciones
├── schema.sql              # Esquema idempotente
├── data/questions.json     # Preguntas editables
├── instance/               # SQLite no público (se crea al arrancar)
├── templates/index.html    # Shell de la SPA
├── static/css/styles.css   # Diseño Sketch, paletas y responsive
├── static/js/api.js        # Cliente fetch()
├── static/js/app.js        # Vistas, polling y acciones de la SPA
├── static/img/queivzz-icon.svg
├── tests/test_app.py       # Pruebas de backend
├── requirements.txt
├── requirements-dev.txt
├── .env.example
├── .gitignore
├── wsgi.py                 # Entrada WSGI para PythonAnywhere
└── README.md
```

## Seguridad

- El anfitrión y los jugadores reciben tokens aleatorios; en SQLite solo se guarda su hash SHA-256.
- Los tokens se asocian a la sesión firmada de Flask y no se devuelven en las respuestas JSON.
- Las acciones de anfitrión se validan en el servidor contra el token de esa sala.
- Las respuestas se asocian al jugador de la sesión, sin confiar en un identificador enviado por el navegador.
- Los nombres, códigos, textos y puntuaciones se validan de nuevo en el backend.
- Las cookies son `HttpOnly` y `SameSite=Lax`; `Secure` se activa con `SESSION_COOKIE_SECURE=1`.
- Se escapan los textos del usuario antes de insertarlos en el HTML de la SPA.

## Limitaciones conocidas

- **La sesión depende del navegador.** Si se borran las cookies, el anfitrión pierde el control de su sala y un jugador no puede recuperar su identidad. No hay cuentas ni recuperación por correo.
- Las preguntas se cargan al arrancar el servidor; hay que recargar tras editarlas.
- No hay evaluación automática de respuestas ni detección de respuestas repetidas: el anfitrión decide los puntos, como pide el diseño.
- El *polling* introduce un retardo de hasta ~1,5 segundos en la sincronización. No es una experiencia en tiempo real estricto.
- Si Google Fonts no está disponible, se usan fuentes cursivas locales de respaldo; el aspecto puede variar.
- El anfitrión debe mantener la pestaña abierta para controlar la partida y publicar los resultados.
- No se añadió administración de preguntas, compras, anuncios ni cuentas de usuario.

## Verificación realizada y pendientes

**Verificado en este entorno:**

- Python 3.14.6, Flask 3.1.3.
- `python -m py_compile` sobre `app.py`, `config.py`, `database.py` y `wsgi.py`.
- `node --check` sobre `static/js/app.js` y `static/js/api.js` (solo comprobación de sintaxis; Node no forma parte de la aplicación).
- `python -m pytest -q`: **18 pruebas superadas**.
- Arranque con la fábrica de la app y creación automática de SQLite en una ruta temporal.
- Flujo de API completo con anfitrión y dos jugadores de prueba: crear, unirse, iniciar, responder, cerrar, puntuar, avanzar por las 10 preguntas, esperar y mostrar resultados.
- Prueba de integración de la SPA con jsdom 30 y dos clientes separados: carga inicial, creación de sala, ingreso mediante enlace `?room=`, inicio, respuesta con cambio de tipografía, cierre, puntuación, avance a la siguiente pregunta y ciclo completo de las cinco paletas, sin errores de ejecución en la consola simulada.

**No verificado:**

- No se ha desplegado ni probado en PythonAnywhere. Las instrucciones anteriores son una guía de despliegue, no una prueba real en esa plataforma.
- No se ha probado en navegadores reales ni en dispositivos físicos (móvil vertical, horizontal o escritorio), porque el entorno de trabajo no incluía un navegador gráfico. El CSS responsive está implementado, pero conviene revisar visualmente los anchos y el teclado móvil antes de publicar.
- No se ha auditado con herramientas externas de accesibilidad; se incluyeron foco visible, etiquetas, `aria` y respeto por `prefers-reduced-motion`.
- No se ha sometido a pruebas de carga ni a un análisis de seguridad externo.
