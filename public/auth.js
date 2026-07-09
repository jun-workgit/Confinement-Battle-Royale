function verifyAdminPassword(password) {
  return fetch("/api/admin-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  }).then((r) => r.ok);
}

// Prompts for the admin password, verifies it against the server, and resolves
// with the password string on success or `false` if the user cancels.
// `lang` defaults to Chinese so the admin.html login modal is unaffected.
function showPasswordModal(title, lang) {
  const en = lang === "en";
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal-card">
        <div class="modal-title">${title}</div>
        <input type="password" class="modal-input" placeholder="${en ? "Admin password" : "管理员密码"}" autocomplete="off">
        <div class="modal-error" style="display:none;">${en ? "Incorrect password" : "密码错误"}</div>
        <div class="modal-actions">
          <button class="btn secondary modal-cancel">${en ? "Cancel" : "取消"}</button>
          <button class="btn modal-confirm">${en ? "Confirm" : "确认"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector(".modal-input");
    const errorEl = overlay.querySelector(".modal-error");
    input.focus();

    function close(result) {
      document.body.removeChild(overlay);
      resolve(result);
    }

    overlay.querySelector(".modal-cancel").addEventListener("click", () => close(false));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(false); });

    async function attempt() {
      const pw = input.value;
      const ok = await verifyAdminPassword(pw);
      if (ok) {
        close(pw);
      } else {
        errorEl.style.display = "block";
        input.value = "";
        input.focus();
      }
    }

    overlay.querySelector(".modal-confirm").addEventListener("click", attempt);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  });
}
