(function () {
  "use strict";

  var api = window.QzApi;
  var POLL_MS = 1500;
  var RETRY_MS = 3000;
  var PALETTE_STORAGE = "qz.palette";
  var ROOM_STORAGE = "qz.lastRoom";
  var FONT_STORAGE = "qz.font";
  var ALIGN_STORAGE = "qz.align";
  var SIZE_STORAGE = "qz.size";
  var MIN_TEXT_SIZE = 2;
  var MAX_TEXT_SIZE = 5;
  var TEXT_SIZE_STEP = 0.5;

  var PALETTES = [
    { id: "main", name: "Main" },
    { id: "pizza", name: "Pizza" },
    { id: "xb", name: "XB" },
    { id: "amazon", name: "Amazon" },
    { id: "abda", name: "ABDA" }
  ];

  var FONTS = [
    { id: "sans", label: "Sans serif" },
    { id: "serif", label: "Serif" },
    { id: "mono", label: "Monospace" },
    { id: "script", label: "Script" }
  ];

  var ALIGNMENTS = ["left", "center", "right"];
  var ALIGNMENT_LABELS = {
    left: "izquierda",
    center: "centrado",
    right: "derecha"
  };

  var TEXT_SIZES = [2, 2.5, 3, 3.5, 4, 4.5, 5];

  var CHECK_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
    '<path d="M4.5 12.6l4.4 4.4 10.6-11" fill="none" stroke="currentColor" ' +
    'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var els = {};
  var paletteIndex = 0;
  var toastTimer = null;
  var current = {
    code: null,
    role: null,
    state: null,
    signature: null,
    stopped: true,
    pollTimer: null,
    pollInFlight: false,
    transitionBusy: false,
    actionInFlight: 0,
    epoch: 0
  };
  var local = {
    questionKey: null,
    font: "sans",
    align: "left",
    size: MIN_TEXT_SIZE,
    draft: ""
  };

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
      return {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[character];
    });
  }

  function formatScore(value) {
    return new Intl.NumberFormat("es-ES").format(value) + " pts";
  }

  function normalizeCode(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/\s+/g, "")
      .slice(0, 6);
  }

  function fontLabel(fontId) {
    var found = FONTS.filter(function (font) {
      return font.id === fontId;
    })[0];
    return found ? found.label : FONTS[0].label;
  }

  function nextFont(fontId) {
    var index = FONTS.findIndex(function (font) {
      return font.id === fontId;
    });
    return FONTS[(index + 1) % FONTS.length].id;
  }

  function nextAlignment(alignment) {
    var index = ALIGNMENTS.indexOf(alignment);
    return ALIGNMENTS[(index + 1) % ALIGNMENTS.length];
  }

  function alignmentLabel(alignment) {
    return ALIGNMENT_LABELS[alignment] || ALIGNMENT_LABELS.left;
  }

  function alignmentIcon(alignment) {
    var rows =
      alignment === "center"
        ? [
            [4, 16],
            [7, 10],
            [5, 14]
          ]
        : alignment === "right"
          ? [
              [4, 16],
              [10, 10],
              [6, 14]
            ]
          : [
              [4, 16],
              [4, 10],
              [4, 14]
            ];
    var lines = rows
      .map(function (row, index) {
        return (
          '<rect x="' +
          row[0] +
          '" y="' +
          (6 + index * 6) +
          '" width="' +
          row[1] +
          '" height="2.6" rx="1.3"/>'
        );
      })
      .join("");
    return (
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<g fill="currentColor">' +
      lines +
      "</g></svg>"
    );
  }

  function normalizeTextSize(value) {
    var size = Number(value);
    if (!Number.isFinite(size)) {
      return MIN_TEXT_SIZE;
    }
    size = Math.round(size / TEXT_SIZE_STEP) * TEXT_SIZE_STEP;
    return Math.min(MAX_TEXT_SIZE, Math.max(MIN_TEXT_SIZE, size));
  }

  function readStorage(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_error) {
      return;
    }
  }

  function removeStorage(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      return;
    }
  }

  function tIcon(className) {
    var extraClass = className ? " " + className : "";
    return (
      '<svg class="qz-t-icon' +
      extraClass +
      '" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
      '<g fill="currentColor">' +
      '<rect x="4" y="18" width="28" height="28" rx="3""/>' +
      '<rect x="36" y="18" width="28" height="28" rx="3""/>' +
      '<rect x="68" y="18" width="28" height="28" rx="3""/>' +
      '<rect x="36" y="50" width="28" height="28" rx="3""/>' +
      "</g></svg>"
    );
  }

  function splitQuestion(text) {
    var clean = String(text || "");
    var firstSpace = clean.indexOf(" ");
    if (firstSpace === -1) {
      return { head: clean, body: "" };
    }
    return {
      head: clean.slice(0, firstSpace),
      body: clean.slice(firstSpace + 1)
    };
  }

  function roomTopbar(data) {
    return (
      '<div class="room-topbar">' +
      '<span class="mini-brand">' +
      tIcon() +
      "<span>Queivzz</span></span>" +
      '<span class="room-chip">Sala ' +
      escapeHtml(data.room.code) +
      "</span>" +
      "</div>"
    );
  }

  function screenTitle(text, eyebrow) {
    return (
      '<header class="screen-head">' +
      (eyebrow ? '<p class="eyebrow">' + escapeHtml(eyebrow) + "</p>" : "") +
      '<h1 class="screen-title" id="screen-title" tabindex="-1">' +
      escapeHtml(text) +
      "</h1>" +
      "</header>"
    );
  }

  function questionSheet(data) {
    var question = data.question;
    if (!question) {
      return "";
    }
    var parts = splitQuestion(question.text);
    return (
      '<article class="sheet question-sheet">' +
      '<p class="eyebrow">Pregunta ' +
      question.number +
      " de " +
      data.room.totalQuestions +
      "</p>" +
      '<h1 class="question-head" id="screen-title" tabindex="-1">' +
      escapeHtml(parts.head) +
      "</h1>" +
      (parts.body
        ? '<p class="question-body">' + escapeHtml(parts.body) + "</p>"
        : "") +
      '<span class="question-underline" aria-hidden="true"></span>' +
      "</article>"
    );
  }

  function playerList(players) {
    if (!players.length) {
      return '<p class="empty-state">Aún no hay nadie. Comparte el código para empezar.</p>';
    }
    return (
      '<ul class="player-list">' +
      players
        .map(function (player) {
          return (
            "<li><span class=\"player-dot\" aria-hidden=\"true\"></span>" +
            escapeHtml(player.name) +
            "</li>"
          );
        })
        .join("") +
      "</ul>"
    );
  }

  function statusPill(kind, text) {
    return (
      '<span class="status-pill status-pill--' +
      kind +
      '">' +
      escapeHtml(text) +
      "</span>"
    );
  }

  function renderHome() {
    current.code = null;
    current.role = null;
    current.state = null;
    current.stopped = true;
    current.signature = "home";
    current.pollInFlight = false;
    clearTimeout(current.pollTimer);
    local.questionKey = null;
    local.draft = "";
    setPaletteVisible(false);
    setNetBanner(false);
    document.title = "Queivzz — Preguntas para jugar en grupo";
    els.view.innerHTML =
      '<section class="home">' +
      '<div class="brand-lockup">' +
      tIcon("brand-icon") +
      '<h1 class="brand-title">Queivzz</h1>' +
      "</div>" +
      '<p class="tagline">Basta! + Kahoot! = Queivzz. ' +
      "Responde con originalidad.</p>" +
      '<div class="home-actions">' +
      '<button class="btn btn--primary" type="button" data-action="create-room">Crear partida</button>' +
      '<button class="btn" type="button" data-action="show-join">Unirse a una partida</button>' +
      "</div>" +
      '<p class="note home-note">Si eres invitado, ingresa los 6 caracteres. ' +
      "Utiliza el link para acceder directamente.</p>" +
      "</section>";
  }

  function renderJoin(code, errorMessage) {
    current.code = null;
    current.role = null;
    current.state = null;
    current.stopped = true;
    current.signature = "join";
    current.pollInFlight = false;
    clearTimeout(current.pollTimer);
    setPaletteVisible(false);
    setNetBanner(false);
    document.title = "Unirse a una partida — Queivzz";
    els.view.innerHTML =
      '<div class="join-wrap">' +
      '<div class="form-head">' +
      '<button class="btn btn--small btn--ghost" type="button" data-action="go-home">← Volver</button>' +
      '<p class="eyebrow">Unirse a una partida</p>' +
      "</div>" +
      '<section class="sheet sheet--tape">' +
      "<h1 class=\"screen-title\" id=\"screen-title\" tabindex=\"-1\">Entrar a la sala</h1>" +
      '<p class="hint">Pide el código al anfitrión. Tu nombre aparecerá en la lista de la sala.</p>' +
      '<form id="join-form" novalidate>' +
      '<div class="field">' +
      '<label for="join-code">Código de sala</label>' +
      '<input class="input input--code" id="join-code" name="code" type="text" ' +
      'maxlength="6" inputmode="text" autocomplete="off" autocapitalize="characters" ' +
      'spellcheck="false" required value="' +
      escapeHtml(code || "") +
      '">' +
      "</div>" +
      '<div class="field">' +
      '<label for="join-name">Tu nombre</label>' +
      '<input class="input" id="join-name" name="name" type="text" maxlength="15" ' +
      'autocomplete="nickname" enterkeyhint="go" required ' +
      'aria-describedby="join-name-hint">' +
      '<span class="hint" id="join-name-hint">Máximo 15 caracteres. No puede repetirse en la sala.</span>' +
      "</div>" +
      '<p class="field-error" id="join-error" role="alert">' +
      escapeHtml(errorMessage || "") +
      "</p>" +
      '<div class="form-actions">' +
      '<button class="btn btn--primary" type="submit">Entrar a la sala</button>' +
      "</div>" +
      "</form>" +
      "</section>" +
      "</div>";
  }

  function renderHostLobby(data) {
    var players = data.players || [];
    return (
      roomTopbar(data) +
      '<section class="screen">' +
      screenTitle("Comparte el código", "Sala de espera") +
      '<div class="lobby-grid">' +
      '<section class="sheet sheet--tape code-sheet">' +
      '<p class="eyebrow">Código de sala</p>' +
      '<p class="room-code" aria-label="Código de sala ' +
      escapeHtml(data.room.code) +
      '">' +
      escapeHtml(data.room.code) +
      "</p>" +
      '<div class="share-actions">' +
      '<button class="btn" type="button" data-action="copy-code">Copiar código</button>' +
      '<button class="btn" type="button" data-action="copy-link">Copiar enlace</button>' +
      "</div>" +
      '<p class="hint">Quien quiera jugar debe abrir Queivzz e introducir este código.</p>' +
      "</section>" +
      '<section class="sheet">' +
      '<div class="players-head">' +
      "<h2>Jugadores</h2>" +
      '<span class="count-badge" aria-label="' +
      players.length +
      ' jugadores">' +
      players.length +
      "</span>" +
      "</div>" +
      playerList(players) +
      '<button class="btn btn--primary btn--wide" type="button" data-action="start"' +
      (players.length ? "" : " disabled") +
      ">Iniciar actividad</button>" +
      '<p class="hint">El juego no empieza hasta que tú lo decidas.</p>' +
      "</section>" +
      "</div>" +
      "</section>"
    );
  }

  function renderPlayerLobby(data) {
    var name = data.me ? data.me.name : "";
    return (
      roomTopbar(data) +
      '<section class="screen">' +
      '<section class="sheet waiting-sheet sheet--accent">' +
      '<span class="waiting-mark">Estás dentro</span>' +
      '<h1 class="screen-title" id="screen-title" tabindex="-1">Hola, ' +
      escapeHtml(name) +
      "</h1>" +
      "<p>Ya estás en la sala. Espera a que el anfitrión inicie la actividad.</p>" +
      '<p class="hint">Sala ' +
      escapeHtml(data.room.code) +
      " · " +
      data.playersCount +
      (data.playersCount === 1 ? " jugador conectado" : " jugadores conectados") +
      "</p>" +
      '<p class="note">Cuando empiece la primera pregunta, tu pantalla cambiará sola.</p>' +
      "</section>" +
      "</section>"
    );
  }

  function answerCardOpen(player) {
    return (
      '<article class="player-card">' +
      '<div class="player-card__head">' +
      '<h3 class="player-card__name">' +
      escapeHtml(player.name) +
      "</h3>" +
      statusPill(
        player.answered ? "sent" : "pending",
        player.answered ? "Enviada" : "Pendiente"
      ) +
      "</div>" +
      '<p class="hint">' +
      (player.answered
        ? "Respuesta recibida."
        : "Todavía no ha confirmado su respuesta.") +
      "</p>" +
      "</article>"
    );
  }

  function renderHostQuestion(data) {
    var players = data.players || [];
    var progress = data.progress || { answered: 0, total: 0 };
    return (
      roomTopbar(data) +
      '<section class="screen">' +
      '<div class="quiz-meta">' +
      '<p class="eyebrow">Pregunta ' +
      data.question.number +
      " de " +
      data.room.totalQuestions +
      "</p>" +
      statusPill("info", "Respuestas abiertas") +
      "</div>" +
      '<div class="host-layout">' +
      questionSheet(data) +
      '<section class="sheet host-side">' +
      '<div class="players-head">' +
      "<h2>Jugadores</h2>" +
      '<span class="count-badge" aria-label="' +
      progress.answered +
      " de " +
      progress.total +
      ' respuestas">' +
      progress.answered +
      "/" +
      progress.total +
      "</span>" +
      "</div>" +
      '<div class="host-players">' +
      players.map(answerCardOpen).join("") +
      "</div>" +
      '<p class="progress-copy">' +
      (progress.answered === progress.total && progress.total > 0
        ? "Todos han respondido. Puedes cerrar la pregunta."
        : "Las respuestas se actualizan automáticamente.") +
      "</p>" +
      '<button class="btn btn--primary btn--wide" type="button" data-action="close-question">Cerrar pregunta</button>' +
      '<p class="hint">Al cerrar la pregunta dejarás de aceptar respuestas y pasarás a puntuar.</p>' +
      "</section>" +
      "</div>" +
      "</section>"
    );
  }

  function scoreButton(player, value) {
    var selected = player.score === value;
    return (
      '<button class="score-btn" type="button" data-action="score" data-player-id="' +
      player.id +
      '" data-score="' +
      value +
      '" aria-pressed="' +
      (selected ? "true" : "false") +
      '" aria-label="' +
      escapeHtml(value + " puntos para " + player.name) +
      '">' +
      value +
      " pts</button>"
    );
  }

  function answerCardScoring(player) {
    var hasAnswer = Boolean(player.answerText);
    return (
      '<article class="player-card">' +
      '<div class="player-card__head">' +
      '<h3 class="player-card__name">' +
      escapeHtml(player.name) +
      "</h3>" +
      (player.score === null || player.score === undefined
        ? statusPill("info", "Sin puntuar")
        : statusPill("sent", player.score + " pts")) +
      "</div>" +
      '<p class="player-card__answer' +
      (hasAnswer ? "" : " player-card__answer--empty") +
      '">' +
      (hasAnswer ? escapeHtml(player.answerText) : "Sin respuesta") +
      "</p>" +
      '<div class="score-options" role="group" aria-label="Puntuación de ' +
      escapeHtml(player.name) +
      '">' +
      scoreButton(player, 0) +
      scoreButton(player, 50) +
      scoreButton(player, 100) +
      "</div>" +
      "</article>"
    );
  }

  function renderHostScoring(data) {
    var players = data.players || [];
    var progress = data.progress || { remaining: 0, total: 0, scored: 0 };
    var isLast = data.room.questionIndex + 1 >= data.room.totalQuestions;
    var allScored = progress.remaining === 0 && progress.total > 0;
    return (
      roomTopbar(data) +
      '<section class="screen">' +
      '<div class="quiz-meta">' +
      '<p class="eyebrow">Pregunta ' +
      data.question.number +
      " de " +
      data.room.totalQuestions +
      "</p>" +
      statusPill("info", "Puntuando") +
      "</div>" +
      '<div class="host-layout">' +
      questionSheet(data) +
      '<section class="sheet host-side">' +
      '<div class="players-head">' +
      "<h2>Asigna puntos</h2>" +
      '<span class="count-badge" aria-label="' +
      progress.scored +
      " de " +
      progress.total +
      ' jugadores puntuados">' +
      progress.scored +
      "/" +
      progress.total +
      "</span>" +
      "</div>" +
      '<div class="host-players">' +
      players.map(answerCardScoring).join("") +
      "</div>" +
      '<p class="progress-copy">' +
      (allScored
        ? "Todo el mundo tiene puntos. Ya puedes continuar."
        : "Faltan " +
          progress.remaining +
          (progress.remaining === 1
            ? " participante por calificar."
            : " participantes por calificar.")) +
      "</p>" +
      '<button class="btn btn--primary btn--wide" type="button" data-action="next"' +
      (allScored ? "" : " disabled") +
      ">" +
      (isLast ? "Finalizar actividad" : "Siguiente pregunta") +
      "</button>" +
      '<p class="hint">0 pts: incorrecta · 50 pts: repetida · 100 pts: correcta y única.</p>' +
      "</section>" +
      "</div>" +
      "</section>"
    );
  }

  function sentBanner(message, smallMessage) {
    return (
      '<div class="sent-banner" tabindex="-1">' +
      CHECK_ICON +
      "<p>" +
      escapeHtml(message) +
      (smallMessage
        ? '<span class="sent-banner__small">' +
          escapeHtml(smallMessage) +
          "</span>"
        : "") +
      "</p>" +
      "</div>"
    );
  }

  function renderPlayerQuestion(data) {
    var answer = data.me ? data.me.answer : null;
    var confirmed = Boolean(answer);
    var font = confirmed && answer.font ? answer.font : local.font;
    if (FONTS.every(function (item) { return item.id !== font; })) {
      font = "sans";
    }
    var align =
      ALIGNMENTS.indexOf(local.align) !== -1 ? local.align : "left";
    var size = normalizeTextSize(local.size);
    var text = confirmed ? answer.text : local.draft;
    var placeholder = confirmed
      ? "Respuesta enviada"
      : "Escribe aquí tu respuesta...";
    return (
      roomTopbar(data) +
      '<section class="screen player-screen">' +
      '<div class="quiz-meta">' +
      '<p class="eyebrow">Pregunta ' +
      data.question.number +
      " de " +
      data.room.totalQuestions +
      "</p>" +
      statusPill(
        confirmed ? "sent" : "info",
        confirmed ? "Respuesta enviada" : "Escribe y confirma"
      ) +
      "</div>" +
      '<div class="player-layout">' +
      questionSheet(data) +
      '<section class="answer-panel" aria-label="Pizarrón de respuesta">' +
      '<div class="board-label"><span>Pizarrón</span><span class="board-label__hint">' +
      (confirmed ? "Respuesta confirmada" : "Toca para escribir") +
      "</span></div>" +
      '<div class="board" data-action="focus-board">' +
      '<textarea class="board__textarea" id="answer-input" data-role="answer-input" ' +
      'data-font="' +
      font +
      '" data-align="' +
      align +
      '" data-size="' +
      size +
      '" maxlength="500" aria-label="Escribe tu respuesta" placeholder="' +
      escapeHtml(placeholder) +
      '"' +
      (confirmed ? " readonly" : "") +
      ">" +
      escapeHtml(text) +
      "</textarea>" +
      "</div>" +
      (confirmed
        ? sentBanner(
            "Respuesta enviada",
            "Quedó guardada. Esperando a que el anfitrión cierre la pregunta."
          )
        : '<p class="field-error" id="answer-error" role="alert"></p>' +
          '<div class="answer-controls">' +
          '<div class="answer-controls__group">' +
          '<button class="btn font-toggle" type="button" data-action="font-toggle" data-font="' +
          font +
          '" aria-label="' +
          escapeHtml("Cambiar tipografía. Actual: " + fontLabel(font)) +
          '">Aa</button>' +
          '<button class="btn align-toggle" type="button" data-action="align-toggle" data-align="' +
          align +
          '" aria-label="' +
          escapeHtml(
            "Cambiar alineación del texto. Actual: " + alignmentLabel(align)
          ) +
          '">' +
          alignmentIcon(align) +
          "</button>" +
          '<button class="btn size-toggle" type="button" data-action="size-down" aria-label="Reducir tamaño del texto"' +
          (size <= MIN_TEXT_SIZE ? " disabled" : "") +
          ">-</button>" +
          '<button class="btn size-toggle" type="button" data-action="size-up" aria-label="Aumentar tamaño del texto"' +
          (size >= MAX_TEXT_SIZE ? " disabled" : "") +
          ">+</button>" +
          "</div>" +
          '<button class="btn btn--check" type="button" data-action="submit-answer" aria-label="Confirmar respuesta">' +
          CHECK_ICON +
          "</button>" +
          "</div>") +
      "</section>" +
      "</div>" +
      "</section>"
    );
  }

  function renderPlayerClosed(data) {
    var answer = data.me ? data.me.answer : null;
    var font = answer && answer.font ? answer.font : local.font;
    if (FONTS.every(function (item) { return item.id !== font; })) {
      font = "sans";
    }
    var align =
      ALIGNMENTS.indexOf(local.align) !== -1 ? local.align : "left";
    var size = normalizeTextSize(local.size);
    var text = answer ? answer.text : "";
    return (
      roomTopbar(data) +
      '<section class="screen player-screen">' +
      '<div class="quiz-meta">' +
      '<p class="eyebrow">Pregunta ' +
      data.question.number +
      " de " +
      data.room.totalQuestions +
      "</p>" +
      statusPill("info", "Pregunta cerrada") +
      "</div>" +
      '<div class="player-layout">' +
      questionSheet(data) +
      '<section class="answer-panel" aria-label="Tu respuesta">' +
      '<div class="board-label"><span>Tu pizarrón</span><span class="board-label__hint">' +
      (answer ? "Respuesta enviada" : "Sin respuesta") +
      "</span></div>" +
      '<div class="board">' +
      '<textarea class="board__textarea" id="answer-input" data-role="answer-input" ' +
      'data-font="' +
      font +
      '" data-align="' +
      align +
      '" data-size="' +
      size +
      '" aria-label="Tu respuesta enviada" placeholder="No enviaste respuesta esta vez" readonly>' +
      escapeHtml(text) +
      "</textarea>" +
      "</div>" +
      (answer
        ? sentBanner(
            "Respuesta enviada",
            "El anfitrión está asignando los puntos."
          )
        : '<p class="note">No enviaste respuesta. Espera a la siguiente pregunta.</p>') +
      "</section>" +
      "</div>" +
      "</section>"
    );
  }

  function renderLoader() {
    return (
      '<div class="qz-loader" role="status" aria-label="Esperando resultados">' +
      '<div class="qz-loader__container" aria-hidden="true">' +
      '<div class="qz-loader__elem qz-loader__elem--1"></div>' +
      '<div class="qz-loader__elem qz-loader__elem--2"></div>' +
      '<div class="qz-loader__elem qz-loader__elem--3"></div>' +
      '<div class="qz-loader__elem qz-loader__elem--4"></div>' +
      "</div>" +
      '<p class="qz-loader__text">Esperando resultados...</p>' +
      "</div>"
    );
  }

  function renderPlayerWaiting(data) {
    return (
      roomTopbar(data) +
      '<section class="waiting-screen">' +
      renderLoader() +
      "</section>"
    );
  }

  function renderLeaderboard(data) {
    var rows = data.leaderboard || [];
    var meId = data.me ? data.me.id : null;
    if (!rows.length) {
      return '<p class="empty-state">No hay participantes en la clasificación.</p>';
    }
    return (
      '<ol class="leaderboard" aria-label="Tabla de posiciones">' +
      rows
        .map(function (row) {
          var medal = "";
          var medalName = "";
          if (row.position === 1) {
            medal = "gold";
            medalName = "Oro";
          } else if (row.position === 2) {
            medal = "silver";
            medalName = "Plata";
          } else if (row.position === 3) {
            medal = "bronze";
            medalName = "Bronce";
          }
          return (
            '<li class="rank-row' +
            (row.id === meId ? " rank-row--me" : "") +
            '">' +
            '<span class="rank-pos' +
            (medal ? " rank-pos--" + medal : "") +
            '" aria-label="' +
            escapeHtml((medalName ? medalName + ", " : "") + "posición " + row.position) +
            '">' +
            row.position +
            "</span>" +
            '<span class="rank-name">' +
            escapeHtml(row.name) +
            (row.id === meId ? '<span class="rank-you">Tú</span>' : "") +
            "</span>" +
            '<span class="rank-score">' +
            formatScore(row.total) +
            "</span>" +
            "</li>"
          );
        })
        .join("") +
      "</ol>"
    );
  }

  function renderHostWaiting(data) {
    return (
      roomTopbar(data) +
      '<section class="screen">' +
      screenTitle("Tabla de posiciones", "Última pregunta puntuada") +
      '<section class="sheet">' +
      renderLeaderboard(data) +
      "</section>" +
      '<p class="results-banner">Los jugadores siguen viendo la animación. ' +
      "Tómate tu tiempo para anunciar el top 3.</p>" +
      '<button class="btn btn--primary btn--wide" type="button" data-action="show-results">Mostrar resultados</button>' +
      "</section>"
    );
  }

  function renderResults(data) {
    return (
      roomTopbar(data) +
      '<section class="screen">' +
      screenTitle("Resultados finales", "Actividad finalizada") +
      '<section class="sheet">' +
      renderLeaderboard(data) +
      "</section>" +
      '<div class="form-actions">' +
      '<button class="btn btn--ghost" type="button" data-action="go-home">Volver al inicio</button>' +
      "</div>" +
      "</section>"
    );
  }

  function renderView(data) {
    var status = data.room.status;
    if (data.role === "host") {
      if (status === "lobby") {
        return renderHostLobby(data);
      }
      if (status === "question_open") {
        return renderHostQuestion(data);
      }
      if (status === "scoring") {
        return renderHostScoring(data);
      }
      if (status === "waiting_results") {
        return renderHostWaiting(data);
      }
      return renderResults(data);
    }

    if (status === "lobby") {
      return renderPlayerLobby(data);
    }
    if (status === "question_open") {
      return renderPlayerQuestion(data);
    }
    if (status === "scoring") {
      return renderPlayerClosed(data);
    }
    if (status === "waiting_results") {
      return renderPlayerWaiting(data);
    }
    return renderResults(data);
  }

  function syncLocalState(data) {
    if (data.role !== "player") {
      return;
    }
    var status = data.room.status;
    if (status !== "question_open" && status !== "scoring") {
      return;
    }
    var key = data.room.code + ":" + data.room.questionIndex;
    var answer = data.me ? data.me.answer : null;
    if (local.questionKey !== key) {
      local.questionKey = key;
      local.draft = answer ? answer.text : "";
    }
    if (answer) {
      local.draft = answer.text;
      if (answer.font && FONTS.some(function (font) { return font.id === answer.font; })) {
        local.font = answer.font;
        writeStorage(FONT_STORAGE, local.font);
      }
    }
  }

  function renderState(data, options) {
    var settings = options || {};
    var signature = JSON.stringify(data);
    if (!settings.force && signature === current.signature) {
      return;
    }

    current.state = data;
    current.role = data.role;
    current.code = data.room.code;
    current.signature = signature;
    syncLocalState(data);
    setPaletteVisible(true);

    try {
      els.view.innerHTML = renderView(data);
    } catch (error) {
      els.view.innerHTML =
        '<section class="screen"><section class="sheet">' +
        "<h1>No se pudo dibujar la pantalla</h1>" +
        "<p>Actualiza la página para volver a intentarlo.</p>" +
        "</section></section>";
      showToast("Ocurrió un problema al mostrar la sala.");
      return;
    }

    if (settings.focus) {
      window.requestAnimationFrame(function () {
        var target = els.view.querySelector(settings.focus);
        if (target) {
          target.focus();
        }
      });
    }
  }

  function setPaletteVisible(visible) {
    els.palette.hidden = !visible;
    if (visible) {
      updatePaletteUi();
    }
  }

  function applyPalette(index, announce) {
    paletteIndex = ((index % PALETTES.length) + PALETTES.length) % PALETTES.length;
    var palette = PALETTES[paletteIndex];
    document.documentElement.setAttribute("data-palette", palette.id);
    writeStorage(PALETTE_STORAGE, String(paletteIndex));
    updatePaletteUi();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) {
      var ground = window
        .getComputedStyle(document.documentElement)
        .getPropertyValue("--qz-ground")
        .trim();
      if (ground) {
        meta.setAttribute("content", ground);
      }
    }
    if (announce) {
      showToast("Paleta " + palette.name);
    }
  }

  function updatePaletteUi() {
    var palette = PALETTES[paletteIndex];
    els.paletteName.textContent = palette.name;
    els.palette.setAttribute(
      "aria-label",
      "Cambiar paleta de colores. Paleta actual: " + palette.name
    );
    els.palette.setAttribute("title", "Paleta: " + palette.name);
  }

  function showToast(message, duration) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      els.toast.hidden = true;
    }, duration || 3400);
  }

  function setNetBanner(visible) {
    els.netBanner.hidden = !visible;
  }

  function setButtonBusy(button, busy, label) {
    if (!button) {
      return;
    }
    if (busy) {
      button.dataset.originalLabel = button.textContent;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      if (label) {
        button.textContent = label;
      }
    } else if (button.isConnected) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (button.dataset.originalLabel) {
        button.textContent = button.dataset.originalLabel;
        delete button.dataset.originalLabel;
      }
    }
  }

  function copyText(text, successMessage) {
    function fallbackCopy() {
      var helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.top = "-1000px";
      document.body.appendChild(helper);
      helper.select();
      var copied = false;
      try {
        copied = document.execCommand("copy");
      } catch (_error) {
        copied = false;
      }
      document.body.removeChild(helper);
      if (copied) {
        showToast(successMessage);
      } else {
        showToast("No se pudo copiar. Selecciona el texto manualmente.");
      }
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard
        .writeText(text)
        .then(function () {
          showToast(successMessage);
        })
        .catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function inviteLink(code) {
    var url = new URL(window.location.href);
    url.hash = "";
    url.search = "";
    url.searchParams.set("room", code);
    return url.toString();
  }

  function rememberRoom(code) {
    writeStorage(ROOM_STORAGE, code);
    var url = new URL(window.location.href);
    url.searchParams.set("room", code);
    window.history.replaceState({}, "", url.toString());
  }

  function forgetRoom() {
    removeStorage(ROOM_STORAGE);
    var url = new URL(window.location.href);
    url.searchParams.delete("room");
    window.history.replaceState({}, "", url.toString());
  }

  function enterRoom(code, state) {
    current.code = code;
    current.role = state.role;
    current.state = state;
    current.signature = null;
    current.stopped = false;
    current.pollInFlight = false;
    current.transitionBusy = false;
    current.actionInFlight = 0;
    current.epoch += 1;
    local.questionKey = null;
    local.draft = "";
    rememberRoom(code);
    setNetBanner(false);
    setPaletteVisible(true);
    renderState(state, { force: true });
    schedulePoll(POLL_MS);
  }

  function schedulePoll(delay) {
    clearTimeout(current.pollTimer);
    if (current.stopped || !current.code) {
      return;
    }
    if (document.hidden) {
      return;
    }
    current.pollTimer = window.setTimeout(pollNow, delay);
  }

  function stopPolling() {
    current.stopped = true;
    clearTimeout(current.pollTimer);
    current.pollTimer = null;
  }

  async function pollNow() {
    if (!current.code || current.stopped || current.pollInFlight) {
      return;
    }
    if (document.hidden) {
      return;
    }
    if (current.actionInFlight > 0) {
      schedulePoll(250);
      return;
    }
    current.pollInFlight = true;
    var code = current.code;
    var epoch = current.epoch;
    try {
      var data = await api.getState(code);
      if (code !== current.code) {
        return;
      }
      if (epoch !== current.epoch) {
        schedulePoll(300);
        return;
      }
      setNetBanner(false);
      renderState(data);
      if (data.room.status === "results") {
        stopPolling();
      } else {
        schedulePoll(POLL_MS);
      }
    } catch (error) {
      if (code !== current.code) {
        return;
      }
      if (error.status === 403 || error.status === 404) {
        stopPolling();
        showToast(error.message);
        forgetRoom();
        renderHome();
        return;
      }
      setNetBanner(true);
      schedulePoll(RETRY_MS);
    } finally {
      current.pollInFlight = false;
    }
  }

  function restartPollingSoon() {
    if (!current.stopped && current.code) {
      schedulePoll(0);
    }
  }

  async function doCreate(button) {
    setButtonBusy(button, true, "Creando…");
    try {
      var data = await api.createRoom();
      enterRoom(data.room.code, data);
    } catch (error) {
      showToast(error.message);
      setButtonBusy(button, false);
    }
  }

  async function doJoin(form) {
    var codeInput = form.querySelector("#join-code");
    var nameInput = form.querySelector("#join-name");
    var errorBox = form.querySelector("#join-error");
    var submit = form.querySelector('button[type="submit"]');
    var code = normalizeCode(codeInput.value);
    var name = nameInput.value.trim();

    errorBox.textContent = "";
    if (!code || code.length !== 6) {
      errorBox.textContent = "Introduce un código de sala de 6 caracteres.";
      codeInput.focus();
      return;
    }
    if (!name) {
      errorBox.textContent = "Escribe tu nombre para entrar.";
      nameInput.focus();
      return;
    }
    if (name.length > 15) {
      errorBox.textContent = "El nombre no puede tener más de 15 caracteres.";
      nameInput.focus();
      return;
    }

    setButtonBusy(submit, true, "Entrando…");
    try {
      var data = await api.joinRoom(code, name);
      enterRoom(data.room.code, data);
    } catch (error) {
      errorBox.textContent = error.message;
      if (error.status === 409 && /nombre/i.test(error.message)) {
        nameInput.focus();
      } else {
        codeInput.focus();
      }
      setButtonBusy(submit, false);
    }
  }

  function handleActionError(error) {
    showToast(error.message);
    if (error.status === 0 || error.status >= 500) {
      setNetBanner(true);
    }
    if (error.status === 403 || error.status === 404) {
      stopPolling();
      forgetRoom();
      renderHome();
      return;
    }
    if (error.status === 409) {
      restartPollingSoon();
    }
  }

  async function doTransition(button, action) {
    if (current.transitionBusy) {
      return;
    }
    current.transitionBusy = true;
    current.actionInFlight += 1;
    current.epoch += 1;
    setButtonBusy(button, true);
    try {
      var data = await action(current.code);
      renderState(data, { force: true, focus: "#screen-title" });
    } catch (error) {
      handleActionError(error);
    } finally {
      current.transitionBusy = false;
      current.actionInFlight = Math.max(0, current.actionInFlight - 1);
      setButtonBusy(button, false);
      schedulePoll(POLL_MS);
    }
  }

  async function doScore(button) {
    if (current.transitionBusy) {
      return;
    }
    var playerId = Number(button.dataset.playerId);
    var score = Number(button.dataset.score);
    current.transitionBusy = true;
    current.actionInFlight += 1;
    current.epoch += 1;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      var data = await api.assignScore(current.code, playerId, score);
      renderState(data, {
        force: true,
        focus:
          '.score-btn[data-player-id="' +
          playerId +
          '"][aria-pressed="true"]'
      });
    } catch (error) {
      handleActionError(error);
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
    } finally {
      current.transitionBusy = false;
      current.actionInFlight = Math.max(0, current.actionInFlight - 1);
      schedulePoll(POLL_MS);
    }
  }

  function showBoardError(message) {
    var box = document.querySelector("#answer-error");
    if (box) {
      box.textContent = message;
    }
  }

  async function doSubmitAnswer(button) {
    var textarea = document.querySelector("#answer-input");
    var text = textarea ? textarea.value : local.draft;
    if (!text.trim()) {
      showBoardError("Escribe una respuesta antes de confirmar.");
      if (textarea) {
        textarea.focus();
      }
      return;
    }
    local.draft = text;
    current.actionInFlight += 1;
    current.epoch += 1;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      var data = await api.submitAnswer(current.code, text, local.font);
      renderState(data, { force: true, focus: ".sent-banner" });
    } catch (error) {
      showToast(error.message);
      if (error.status === 409) {
        restartPollingSoon();
      }
    } finally {
      current.actionInFlight = Math.max(0, current.actionInFlight - 1);
      if (button.isConnected) {
        button.disabled = false;
        button.removeAttribute("aria-busy");
      }
      schedulePoll(POLL_MS);
    }
  }

  function focusBoard() {
    var textarea = document.querySelector("#answer-input");
    if (!textarea || textarea.readOnly) {
      return;
    }
    textarea.focus();
    var end = textarea.value.length;
    try {
      textarea.setSelectionRange(end, end);
    } catch (_error) {
      return;
    }
  }

  function cycleFont(button) {
    local.font = nextFont(local.font);
    writeStorage(FONT_STORAGE, local.font);
    var textarea = document.querySelector("#answer-input");
    if (textarea) {
      textarea.dataset.font = local.font;
    }
    button.dataset.font = local.font;
    button.setAttribute(
      "aria-label",
      "Cambiar tipografía. Actual: " + fontLabel(local.font)
    );
  }

  function cycleAlignment(button) {
    local.align = nextAlignment(local.align);
    writeStorage(ALIGN_STORAGE, local.align);
    var textarea = document.querySelector("#answer-input");
    if (textarea) {
      textarea.dataset.align = local.align;
    }
    button.dataset.align = local.align;
    button.innerHTML = alignmentIcon(local.align);
    button.setAttribute(
      "aria-label",
      "Cambiar alineación del texto. Actual: " + alignmentLabel(local.align)
    );
  }

  function updateSizeButtons() {
    var smaller = document.querySelector('[data-action="size-down"]');
    var larger = document.querySelector('[data-action="size-up"]');
    if (smaller) {
      smaller.disabled = local.size <= MIN_TEXT_SIZE;
      smaller.setAttribute(
        "aria-label",
        "Reducir tamaño del texto. Actual: " + local.size + " rem"
      );
    }
    if (larger) {
      larger.disabled = local.size >= MAX_TEXT_SIZE;
      larger.setAttribute(
        "aria-label",
        "Aumentar tamaño del texto. Actual: " + local.size + " rem"
      );
    }
  }

  function changeTextSize(delta) {
    local.size = normalizeTextSize(local.size + delta);
    writeStorage(SIZE_STORAGE, String(local.size));
    var textarea = document.querySelector("#answer-input");
    if (textarea) {
      textarea.dataset.size = String(local.size);
    }
    updateSizeButtons();
  }

  function handleClick(event) {
    var board = event.target.closest(".board");
    if (board && !event.target.matches("textarea")) {
      focusBoard();
    }

    var target = event.target.closest("[data-action]");
    if (!target) {
      return;
    }
    var action = target.dataset.action;

    if (action === "focus-board" || action === "score") {
      if (action === "score") {
        event.preventDefault();
        doScore(target);
      }
      return;
    }
    if (action === "font-toggle") {
      event.preventDefault();
      cycleFont(target);
      return;
    }
    if (action === "align-toggle") {
      event.preventDefault();
      cycleAlignment(target);
      return;
    }
    if (action === "size-down") {
      event.preventDefault();
      changeTextSize(-TEXT_SIZE_STEP);
      return;
    }
    if (action === "size-up") {
      event.preventDefault();
      changeTextSize(TEXT_SIZE_STEP);
      return;
    }
    if (action === "submit-answer") {
      event.preventDefault();
      doSubmitAnswer(target);
      return;
    }
    if (action === "create-room") {
      event.preventDefault();
      doCreate(target);
      return;
    }
    if (action === "show-join") {
      event.preventDefault();
      renderJoin("");
      return;
    }
    if (action === "go-home") {
      event.preventDefault();
      stopPolling();
      forgetRoom();
      renderHome();
      return;
    }
    if (action === "copy-code" && current.state) {
      event.preventDefault();
      copyText(current.state.room.code, "Código copiado.");
      return;
    }
    if (action === "copy-link" && current.state) {
      event.preventDefault();
      copyText(
        inviteLink(current.state.room.code),
        "Enlace de invitación copiado."
      );
      return;
    }
    if (action === "start") {
      event.preventDefault();
      doTransition(target, api.startRoom);
      return;
    }
    if (action === "close-question") {
      event.preventDefault();
      doTransition(target, api.closeQuestion);
      return;
    }
    if (action === "next") {
      event.preventDefault();
      doTransition(target, api.nextQuestion);
      return;
    }
    if (action === "show-results") {
      event.preventDefault();
      doTransition(target, api.showResults);
    }
  }

  function handleInput(event) {
    var target = event.target;
    if (target.matches("[data-role='answer-input']")) {
      local.draft = target.value;
      var errorBox = document.querySelector("#answer-error");
      if (errorBox && errorBox.textContent) {
        errorBox.textContent = "";
      }
      return;
    }
    if (target.id === "join-code") {
      target.value = normalizeCode(target.value);
    }
  }

  function handleSubmit(event) {
    if (event.target.id === "join-form") {
      event.preventDefault();
      doJoin(event.target);
    }
  }

  function bindEvents() {
    els.palette.addEventListener("click", function () {
      applyPalette(paletteIndex + 1, true);
    });
    els.view.addEventListener("click", handleClick);
    els.view.addEventListener("input", handleInput);
    els.view.addEventListener("submit", handleSubmit);
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        clearTimeout(current.pollTimer);
        current.pollTimer = null;
      } else if (current.code && !current.stopped) {
        pollNow();
      }
    });
    window.addEventListener("online", function () {
      setNetBanner(false);
      if (current.code && !current.stopped) {
        pollNow();
      }
    });
    window.addEventListener("offline", function () {
      setNetBanner(true);
    });
  }

  async function tryRestore(code) {
    try {
      var data = await api.getState(code);
      enterRoom(data.room.code, data);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error };
    }
  }

  async function init() {
    els.view = document.querySelector("#view");
    els.palette = document.querySelector("#palette-toggle");
    els.paletteName = document.querySelector("#palette-name");
    els.toast = document.querySelector("#toast");
    els.netBanner = document.querySelector("#net-banner");

    var storedPalette = Number(readStorage(PALETTE_STORAGE));
    paletteIndex =
      Number.isInteger(storedPalette) &&
      storedPalette >= 0 &&
      storedPalette < PALETTES.length
        ? storedPalette
        : 0;
    applyPalette(paletteIndex, false);

    var storedFont = readStorage(FONT_STORAGE);
    local.font = FONTS.some(function (font) {
      return font.id === storedFont;
    })
      ? storedFont
      : "sans";

    var storedAlign = readStorage(ALIGN_STORAGE);
    local.align =
      ALIGNMENTS.indexOf(storedAlign) !== -1 ? storedAlign : "left";

    var storedSize = Number(readStorage(SIZE_STORAGE));
    local.size =
      TEXT_SIZES.indexOf(storedSize) !== -1
        ? storedSize
        : MIN_TEXT_SIZE;

    bindEvents();

    var params = new URLSearchParams(window.location.search);
    var urlCode = normalizeCode(params.get("room") || "");

    if (urlCode) {
      var urlTry = await tryRestore(urlCode);
      if (urlTry.ok) {
        return;
      }
      if (urlTry.error.status === 404) {
        renderJoin(urlCode, "No existe una sala con ese código.");
      } else if (urlTry.error.status === 0) {
        renderJoin(urlCode);
        showToast(urlTry.error.message);
      } else {
        renderJoin(urlCode);
      }
      return;
    }

    var storedRoom = normalizeCode(readStorage(ROOM_STORAGE) || "");
    if (storedRoom) {
      var storedTry = await tryRestore(storedRoom);
      if (storedTry.ok) {
        return;
      }
      removeStorage(ROOM_STORAGE);
      if (storedTry.error.status === 0) {
        showToast(storedTry.error.message);
      }
    }

    renderHome();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
