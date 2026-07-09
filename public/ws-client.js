function connectGameSocket(onState) {
  let ws;
  let closedByUs = false;

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") onState(msg.state);
    });
    ws.addEventListener("close", () => {
      if (!closedByUs) setTimeout(connect, 1000);
    });
    ws.addEventListener("error", () => ws.close());
  }
  connect();

  return {
    send(obj) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    close() {
      closedByUs = true;
      ws.close();
    },
  };
}
