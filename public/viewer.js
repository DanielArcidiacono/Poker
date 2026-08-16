(() => {
  const img = document.getElementById("frame");
  const status = document.getElementById("viewer-status");
  if (!(img instanceof HTMLImageElement) || !status) return;

  let socket = null;
  let visibleUrl = null;
  let pendingFrame = null;
  let decoding = false;
  let attempt = 0;
  let closed = false;
  let reconnectTimer = null;
  let frameWaitTimer = null;

  const params = new URLSearchParams(location.search);
  const embedToken = params.get("token");

  function clearFrameWait() {
    if (frameWaitTimer) {
      clearTimeout(frameWaitTimer);
      frameWaitTimer = null;
    }
  }

  function showStatus(message, stale = true) {
    status.textContent = message;
    status.hidden = false;
    img.classList.toggle("stale", stale && Boolean(visibleUrl));
  }

  function showLive() {
    clearFrameWait();
    status.hidden = true;
    img.classList.remove("stale");
  }

  function clearFrames() {
    pendingFrame = null;
    decoding = false;
    if (visibleUrl) {
      URL.revokeObjectURL(visibleUrl);
      visibleUrl = null;
    }
    clearFrameWait();
  }

  // Decode at most one image and retain at most one newer frame. When the
  // browser falls behind, intermediate screenshots are obsolete and dropped.
  function paintLatest() {
    if (decoding || !pendingFrame || closed) return;
    decoding = true;
    const frame = pendingFrame;
    pendingFrame = null;
    const nextUrl = URL.createObjectURL(frame);

    const finish = (showFrame) => {
      const previousUrl = visibleUrl;
      if (showFrame) {
        visibleUrl = nextUrl;
        showLive();
      } else {
        URL.revokeObjectURL(nextUrl);
        showStatus("Could not decode the latest frame. Retrying…");
      }
      if (previousUrl) URL.revokeObjectURL(previousUrl);
      decoding = false;
      paintLatest();
    };

    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = nextUrl;
  }

  function scheduleReconnect() {
    if (closed || document.visibilityState === "hidden") return;
    const delay = Math.min(30000, 500 * 2 ** attempt);
    attempt += 1;
    showStatus("Connection lost. Reconnecting…");
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect() {
    if (
      closed ||
      socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING
    ) {
      return;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const qs = embedToken ? `?token=${encodeURIComponent(embedToken)}` : "";
    const url = `${proto}//${location.host}/ws${qs}`;

    const nextSocket = new WebSocket(url);
    nextSocket.binaryType = "blob";
    socket = nextSocket;
    showStatus("Connecting…");

    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket) return;
      attempt = 0;
      showStatus("Waiting for the first frame…", false);
      clearFrameWait();
      frameWaitTimer = setTimeout(() => {
        showStatus(
          "No frames yet. Check Screen Recording permission on the Mac.",
          false,
        );
      }, 8_000);
    });

    nextSocket.addEventListener("message", (event) => {
      if (socket !== nextSocket) return;
      pendingFrame =
        event.data instanceof Blob
          ? event.data
          : new Blob([event.data], { type: "image/jpeg" });
      paintLatest();
    });

    nextSocket.addEventListener("close", () => {
      if (socket !== nextSocket) return;
      socket = null;
      clearFrameWait();
      scheduleReconnect();
    });

    nextSocket.addEventListener("error", () => {
      nextSocket.close();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const currentSocket = socket;
      socket = null;
      currentSocket?.close(1000, "viewer hidden");
      clearFrameWait();
      return;
    }

    if (socket?.readyState !== WebSocket.OPEN) {
      attempt = 0;
      connect();
    }
  });

  window.addEventListener("pagehide", () => {
    closed = true;
    const currentSocket = socket;
    socket = null;
    currentSocket?.close();
    clearFrames();
  });

  connect();
})();
