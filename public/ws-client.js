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
