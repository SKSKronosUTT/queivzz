(function (global) {
  "use strict";

  async function request(path, options) {
    const settings = options || {};
    const method = settings.method || "GET";
    const headers = { Accept: "application/json" };
    const init = {
      method: method,
      credentials: "same-origin",
      cache: "no-store",
      headers: headers,
    };

    if (settings.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(settings.body);
    }

    let response;
    try {
      response = await fetch(path, init);
    } catch (networkError) {
      const error = new Error(
        "No se pudo conectar con el servidor. Revisa tu conexión."
      );
      error.cause = networkError;
      error.status = 0;
      throw error;
    }

    let data = null;
    try {
      data = await response.json();
    } catch (_jsonError) {
      data = null;
    }

    if (!response.ok) {
      const fallback =
        response.status === 404
          ? "No se encontró lo que buscabas."
          : response.status === 403
            ? "No tienes permiso para esta acción."
            : "No se pudo completar la acción.";
      const error = new Error((data && data.error) || fallback);
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  function roomPath(code, suffix) {
    return "/api/rooms/" + encodeURIComponent(code) + suffix;
  }

  global.QzApi = {
    createRoom: function () {
      return request("/api/rooms", { method: "POST", body: {} });
    },
    joinRoom: function (code, name) {
      return request("/api/rooms/join", {
        method: "POST",
        body: { code: code, name: name },
      });
    },
    getState: function (code) {
      return request(roomPath(code, "/state"));
    },
    startRoom: function (code) {
      return request(roomPath(code, "/start"), { method: "POST", body: {} });
    },
    submitAnswer: function (code, text, font) {
      return request(roomPath(code, "/answers"), {
        method: "POST",
        body: { text: text, font: font },
      });
    },
    closeQuestion: function (code) {
      return request(roomPath(code, "/close-question"), {
        method: "POST",
        body: {},
      });
    },
    assignScore: function (code, playerId, score) {
      return request(roomPath(code, "/scores"), {
        method: "POST",
        body: { playerId: playerId, score: score },
      });
    },
    nextQuestion: function (code) {
      return request(roomPath(code, "/next"), { method: "POST", body: {} });
    },
    showResults: function (code) {
      return request(roomPath(code, "/show-results"), {
        method: "POST",
        body: {},
      });
    },
  };
})(window);
