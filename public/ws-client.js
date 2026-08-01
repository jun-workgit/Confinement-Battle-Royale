// `onPong` is optional (only admin.html/public.html pass one -- see their
// own startPingIndicator calls; index.html's single-arg call leaves it
// undefined, so a stray "pong" there is simply never dispatched anywhere).
function connectGameSocket(onState, onPong) {
  let ws;
  let closedByUs = false;

  function connect() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "state") onState(msg.state);
      else if (msg.type === "pong" && onPong) onPong(msg.ts);
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

// Connection-liveness indicator (admin.html/public.html only) -- pings once
// a second over the SAME socket the rest of the app already uses (no
// separate connection), showing round-trip latency in a small fixed badge
// top-right. Falls back to a "reconnecting" state if a pong hasn't arrived
// in a while, since the underlying socket already silently auto-reconnects
// on its own (see connectGameSocket's close handler) with no other visible
// sign that happened.
function startPingIndicator(socket) {
  const badge = document.createElement("div");
  badge.className = "ping-indicator";
  badge.innerHTML = `<span class="ping-dot"></span><span class="ping-text">--</span>`;
  document.body.appendChild(badge);
  const dot = badge.querySelector(".ping-dot");
  const text = badge.querySelector(".ping-text");

  let lastPongAt = Date.now();
  setInterval(() => {
    socket.send({ type: "ping", ts: Date.now() });
    // No pong in 3+ seconds (about 3 missed beats) -- the underlying socket
    // is very likely mid-reconnect (see connectGameSocket), so say so
    // instead of just freezing on the last good number.
    if (Date.now() - lastPongAt > 3000) {
      dot.className = "ping-dot down";
      text.textContent = "重连中…";
    }
  }, 1000);

  return function onPong(ts) {
    lastPongAt = Date.now();
    const rtt = Date.now() - ts;
    dot.className = "ping-dot up";
    text.textContent = `${rtt}ms`;
  };
}

// --- Shared countdown-timer helpers (state.timer, admin-controlled) ---

function timerRemainingSec(timer) {
  if (!timer) return 0;
  if (timer.running && timer.endsAt) return Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
  return Math.max(0, timer.remainingSec || 0);
}

function formatTimerClock(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

// Live-updates every element carrying [data-timer-clock] from the timer in
// the latest state (via the getter), so re-renders can stay event-driven and
// the once-a-second text change never rebuilds the page. Also mirrors the
// state onto .running/.expired classes for styling.
function startTimerTicker(getTimer) {
  function tick() {
    const timer = getTimer();
    const els = document.querySelectorAll("[data-timer-clock]");
    if (!els.length) return;
    const left = timerRemainingSec(timer);
    const text = formatTimerClock(left);
    const expired = !!timer && timer.durationSec > 0 && left === 0;
    for (const el of els) {
      if (el.textContent !== text) el.textContent = text;
      el.classList.toggle("running", !!timer && timer.running && left > 0);
      el.classList.toggle("expired", expired);
    }
  }
  setInterval(tick, 250);
  return tick;
}
