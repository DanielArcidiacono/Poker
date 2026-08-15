(() => {
  const img = document.getElementById("frame");
  if (!(img instanceof HTMLImageElement)) return;

  let socket = null;
  let objectUrl = null;
  let attempt = 0;
  let closed = false;
  let reconnectTimer = null;

  const params = new URLSearchParams(location.search);
  const embedToken = params.get("token");

  function clearFrameUrl() {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  function scheduleReconnect() {
    if (closed) return;
    const delay = Math.min(30000, 500 * 2 ** attempt);
    attempt += 1;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = embedToken ? `?token=${encodeURIComponent(embedToken)}` : "";
    const url = `${proto}//${location.host}/ws${qs}`;

    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    socket.addEventListener("open", () => {
      attempt = 0;
    });

    socket.addEventListener("message", (event) => {
      const blob = new Blob([event.data], { type: "image/jpeg" });
      clearFrameUrl();
      objectUrl = URL.createObjectURL(blob);
      img.src = objectUrl;
    });

    socket.addEventListener("close", () => {
      scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      socket?.close();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (
      document.visibilityState === "visible" &&
      socket?.readyState !== WebSocket.OPEN
    ) {
      attempt = 0;
      connect();
    }
  });

  window.addEventListener("pagehide", () => {
    closed = true;
    socket?.close();
    clearFrameUrl();
  });

  connect();
})();
