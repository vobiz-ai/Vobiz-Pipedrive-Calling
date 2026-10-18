/** === Vobiz Calling for Pipedrive — Softphone Logic ===
 *
 * Supports:
 * 1. Dual login:
 *    - Mode 1: Vobiz account (Auth ID & Auth Token)
 *    - Mode 2: SIP direct (SIP username, SIP password & Outbound Caller ID)
 * 2. Incoming call banner with Web Audio ringtone & Accept/Decline keyboard shortcuts.
 * 3. Inbound call completed notification popup modal + native HTML5 desktop notification.
 * 4. Outbound calling with custom caller ID headers, keypad, live timer, mute, hold.
 * 5. Pipedrive contact auto-matching and call recording list with proxy playback.
 */

document.addEventListener("DOMContentLoaded", () => {
  "use strict";

  // Elements
  const statusBadge = document.getElementById("status");
  const statusMessage = document.getElementById("status-message");

  // Inbound Call Done Modal Elements
  const inboundDoneModal = document.getElementById("inboundCallDoneModal");
  const inboundDoneCaller = document.getElementById("inboundDoneCaller");
  const inboundDoneDuration = document.getElementById("inboundDoneDuration");
  const inboundDoneTime = document.getElementById("inboundDoneTime");
  const inboundDoneDismissBtn = document.getElementById("inboundDoneDismissBtn");

  // Incoming Call Elements
  const incomingBanner = document.getElementById("incoming");
  const incomingFromEl = document.getElementById("incoming-from");
  const acceptBtn = document.getElementById("acceptbtn");
  const declineBtn = document.getElementById("declinebtn");

  // Dual Login Tabs & Panels
  const modeAccountTab = document.getElementById("mode-account-tab");
  const modeSipTab = document.getElementById("mode-sip-tab");
  const modeAccountPanel = document.getElementById("mode-account");
  const modeSipPanel = document.getElementById("mode-sip");
  const stepCallerId = document.getElementById("step-caller-id");

  // Account Mode Form
  const authIdInput = document.getElementById("vobiz-auth-id");
  const authTokenInput = document.getElementById("vobiz-auth-token");
  const agentSelect = document.getElementById("loginAgentSelect");
  const accountLoginBtn = document.getElementById("vobiz-login-btn");

  // SIP Direct Mode Form
  const sipUserInput = document.getElementById("sip-username");
  const sipPassInput = document.getElementById("sip-password");
  const sipCallerIdInput = document.getElementById("sip-caller-id");
  const sipRememberCheck = document.getElementById("sip-remember");
  const sipConnectBtn = document.getElementById("sip-connect-btn");

  const loginStatusEl = document.getElementById("vobiz-login-status");
  const logoutBtn = document.getElementById("logoutBtn");

  // Step 2 & 3: Caller ID & Dialer
  const numberSelect = document.getElementById("vobiz-number-select");
  const dialInput = document.getElementById("dialnumber");
  const dialBtn = document.getElementById("dialbtn");
  const hangupBtn = document.getElementById("hangupbtn");
  const dialHint = document.getElementById("dial-hint");
  const callNumEl = document.getElementById("callnum");
  const callStatusText = document.getElementById("callStatusText");
  const callTimer = document.getElementById("callTimer");
  const callControls = document.getElementById("callControls");
  const muteBtn = document.getElementById("muteBtn");
  const holdBtn = document.getElementById("holdBtn");

  // Pipedrive Contact
  const contactBox = document.getElementById("contactBox");
  const pdContactName = document.getElementById("pdContactName");
  const pdContactPhone = document.getElementById("pdContactPhone");
  const pdContactEmail = document.getElementById("pdContactEmail");
  const pdContactOrg = document.getElementById("pdContactOrg");
  const pdDealTag = document.getElementById("pdDealTag");
  const refreshContactBtn = document.getElementById("refreshContactBtn");

  // History & Activity Log
  const historyList = document.getElementById("call-history-list");
  const refreshHistoryBtn = document.getElementById("refresh-history-btn");
  const playbackAudio = document.getElementById("vobiz-playback-audio");
  const remoteAudio = document.getElementById("vobiz-remote-audio");
  const logContainer = document.getElementById("logContainer");

  // State variables
  const AUTH_MODE_KEY = "vobiz_pipedrive_auth_mode";
  const SIP_CREDS_KEY = "vobiz_pipedrive_sip_creds";
  const SESSION_KEY = "vobiz_pipedrive_session";

  let authMode = "account"; // "account" | "sip"

  // Bearer header for the backend routes that read CRM data or recordings.
  // SIP-direct mode has no backend session, so those features need an
  // account sign-in.
  function authHeaders() {
    try {
      const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      return s && s.token ? { Authorization: `Bearer ${s.token}` } : {};
    } catch {
      return {};
    }
  }
  let accountReady = false;
  let sipRegistered = false;
  let currentCallDirection = "Outbound"; // "Inbound" | "Outbound"
  let incomingPending = false;
  let incomingCallerNumber = "";
  let callTimerInterval = null;
  let secondsElapsed = 0;
  let isMuted = false;
  let isOnHold = false;
  let currentCallStartTime = null;

  // Web Audio Ringtone generator
  let ringCtx = null;
  let ringTimer = null;

  function log(msg, type = "info") {
    if (!logContainer) return;
    const div = document.createElement("div");
    div.className = `log-line ${type}`;
    const time = new Date().toLocaleTimeString();
    div.textContent = `[${time}] ${msg}`;
    logContainer.appendChild(div);
    logContainer.scrollTop = logContainer.scrollHeight;
  }

  // Request browser Notification permission
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }

  function setStatus(text, tone = "pending") {
    if (statusBadge) {
      if (text === "Ready" || tone === "ok") {
        statusBadge.textContent = "READY";
        statusBadge.className = "status-badge is-ok registered";
      } else if (tone === "error") {
        statusBadge.textContent = "OFFLINE";
        statusBadge.className = "status-badge is-error unregistered";
      } else if (tone === "busy") {
        statusBadge.textContent = "ON CALL";
        statusBadge.className = "status-badge is-busy";
      } else {
        statusBadge.textContent = text.toUpperCase();
        statusBadge.className = `status-badge is-${tone}`;
      }
    }

    if (statusMessage) {
      statusMessage.textContent = text;
      statusMessage.className = `status-message is-${tone}`;
    }
  }

  function setLoginStatus(text) {
    if (loginStatusEl) loginStatusEl.textContent = text;
  }

  function updateDialButtonState() {
    const canDial = accountReady && sipRegistered;
    if (dialBtn) dialBtn.disabled = !canDial;
    if (dialInput) dialInput.disabled = !accountReady;
    if (numberSelect) numberSelect.disabled = !accountReady;

    if (!accountReady) {
      if (dialHint) dialHint.textContent = "Sign in to activate the dialer.";
    } else if (!sipRegistered) {
      if (dialHint) dialHint.textContent = "Connecting to Vobiz registrar…";
    } else {
      if (dialHint) dialHint.textContent = "";
    }
  }

  // ─── Dual Login Tab Switching ──────────────────────────────────────────────

  function setAuthMode(mode) {
    authMode = mode === "sip" ? "sip" : "account";
    localStorage.setItem(AUTH_MODE_KEY, authMode);

    const isSip = authMode === "sip";
    if (modeAccountPanel) modeAccountPanel.hidden = isSip;
    if (modeSipPanel) modeSipPanel.hidden = !isSip;
    if (stepCallerId) stepCallerId.hidden = isSip;

    if (modeAccountTab) {
      modeAccountTab.classList.toggle("is-active", !isSip);
      modeAccountTab.setAttribute("aria-selected", String(!isSip));
    }
    if (modeSipTab) {
      modeSipTab.classList.toggle("is-active", isSip);
      modeSipTab.setAttribute("aria-selected", String(isSip));
    }
  }

  if (modeAccountTab) modeAccountTab.addEventListener("click", () => setAuthMode("account"));
  if (modeSipTab) modeSipTab.addEventListener("click", () => setAuthMode("sip"));

  // ─── Ringtone Generator ───────────────────────────────────────────────────

  function startRingtone() {
    stopRingtone();
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ringCtx = new AudioCtx();
      const beep = () => {
        if (!ringCtx) return;
        const osc = ringCtx.createOscillator();
        const gain = ringCtx.createGain();
        osc.frequency.value = 440;
        gain.gain.setValueAtTime(0.0001, ringCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.15, ringCtx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + 0.9);
        osc.connect(gain).connect(ringCtx.destination);
        osc.start();
        osc.stop(ringCtx.currentTime + 0.95);
      };
      beep();
      ringTimer = setInterval(beep, 2000);
    } catch (e) {
      console.warn("[Ringtone] Note:", e);
    }
  }

  function stopRingtone() {
    if (ringTimer) { clearInterval(ringTimer); ringTimer = null; }
    if (ringCtx) {
      try { ringCtx.close(); } catch { /* ignore */ }
      ringCtx = null;
    }
  }

  // ─── Inbound Call Done Popup Notification ──────────────────────────────────

  function showInboundCallDoneNotification(callerNumber, durationSec, timestamp) {
    if (inboundDoneCaller) inboundDoneCaller.textContent = callerNumber || "Inbound Call";
    if (inboundDoneDuration) inboundDoneDuration.textContent = formatDuration(durationSec);
    if (inboundDoneTime) inboundDoneTime.textContent = timestamp || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    if (inboundDoneModal) {
      inboundDoneModal.hidden = false;
      inboundDoneModal.classList.remove("hidden");
    }

    // Native desktop OS notification if browser has permission
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("📞 Inbound Call Completed", {
          body: `Call from ${callerNumber} ended. Duration: ${formatDuration(durationSec)}. Synced to Pipedrive CRM.`,
          icon: "/favicon.ico"
        });
      } catch (e) { /* ignore */ }
    }

    log(`[Notification] Inbound call completed from ${callerNumber} (Duration: ${formatDuration(durationSec)}) - logged to Pipedrive.`, "success");
  }

  function dismissInboundCallDoneModal() {
    if (inboundDoneModal) {
      inboundDoneModal.hidden = true;
      inboundDoneModal.classList.add("hidden");
    }
  }

  if (inboundDoneDismissBtn) {
    inboundDoneDismissBtn.addEventListener("click", dismissInboundCallDoneModal);
  }
  if (inboundDoneModal) {
    inboundDoneModal.addEventListener("click", (e) => {
      if (e.target === inboundDoneModal) dismissInboundCallDoneModal();
    });
  }

  // ─── Incoming Call Flow ───────────────────────────────────────────────────

  function showIncomingBanner(caller) {
    incomingCallerNumber = caller || "Unknown";
    if (incomingFromEl) incomingFromEl.textContent = incomingCallerNumber;
    if (incomingBanner) {
      incomingBanner.hidden = false;
      incomingBanner.classList.remove("hidden");
    }
    lookupPipedriveContact(incomingCallerNumber);
  }

  function hideIncomingBanner() {
    incomingPending = false;
    stopRingtone();
    if (incomingBanner) {
      incomingBanner.hidden = true;
      incomingBanner.classList.add("hidden");
    }
  }

  async function acceptIncomingCall() {
    if (!window.VobizSip) return;
    hideIncomingBanner();
    currentCallDirection = "Inbound";
    currentCallStartTime = Date.now();
    const answered = window.VobizSip.answer(remoteAudio);
    if (answered) {
      startCallTimer();
      setHangupVisible(true);
      setStatus("On a call", "busy");
      if (callStatusText) callStatusText.textContent = `Inbound call from ${incomingCallerNumber}`;
      if (callNumEl) callNumEl.hidden = false;
      log(`Accepted incoming call from ${incomingCallerNumber}.`, "success");
    }
  }

  function declineIncomingCall() {
    if (!window.VobizSip) return;
    hideIncomingBanner();
    window.VobizSip.decline();
    log(`Declined incoming call from ${incomingCallerNumber}.`, "info");
    setStatus("Ready", "ok");
  }

  if (acceptBtn) acceptBtn.addEventListener("click", acceptIncomingCall);
  if (declineBtn) declineBtn.addEventListener("click", declineIncomingCall);

  // Keyboard shortcuts (Enter to accept, Escape to decline)
  document.addEventListener("keydown", (e) => {
    if (!incomingPending) return;
    if (e.key === "Enter") {
      e.preventDefault();
      acceptIncomingCall();
    } else if (e.key === "Escape") {
      e.preventDefault();
      declineIncomingCall();
    }
  });

  // ─── Call Timer & Hangup UI ───────────────────────────────────────────────

  function startCallTimer() {
    stopCallTimer();
    secondsElapsed = 0;
    if (callTimer) callTimer.textContent = "00:00";
    callTimerInterval = setInterval(() => {
      secondsElapsed++;
      if (callTimer) callTimer.textContent = formatDuration(secondsElapsed);
    }, 1000);
  }

  function stopCallTimer() {
    if (callTimerInterval) {
      clearInterval(callTimerInterval);
      callTimerInterval = null;
    }
  }

  function formatDuration(sec) {
    const s = parseInt(sec || 0, 10);
    const mins = String(Math.floor(s / 60)).padStart(2, "0");
    const secs = String(s % 60).padStart(2, "0");
    return `${mins}:${secs}`;
  }

  function setHangupVisible(visible) {
    if (dialBtn) dialBtn.hidden = visible;
    if (hangupBtn) hangupBtn.hidden = !visible;
    if (callControls) callControls.hidden = !visible;
    if (callNumEl) callNumEl.hidden = !visible;
  }

  // ─── Vobiz SIP UA Events ──────────────────────────────────────────────────

  function registerSipEvents() {
    if (!window.VobizSip) return;

    window.VobizSip.on("registered", (id) => {
      sipRegistered = true;
      setStatus("Ready", "ok");
      updateDialButtonState();
      log(`SIP registered as ${id.displayName || id.sipUser}`, "success");
    });

    window.VobizSip.on("unregistered", () => {
      sipRegistered = false;
      setStatus("Not registered — reconnecting…", "pending");
      updateDialButtonState();
    });

    window.VobizSip.on("disconnected", () => {
      sipRegistered = false;
      setStatus("Disconnected from registrar", "error");
      updateDialButtonState();
    });

    window.VobizSip.on("registrationFailed", (cause) => {
      sipRegistered = false;
      setStatus(`Registration failed: ${cause}`, "error");
      updateDialButtonState();
      log(`SIP registration error: ${cause}`, "error");
    });

    window.VobizSip.on("progress", () => {
      setStatus("Ringing…", "busy");
      log("Call ringing remote party…", "info");
    });

    window.VobizSip.on("confirmed", () => {
      setStatus("On a call", "busy");
      startCallTimer();
      log("Call connected — audio is live.", "success");
    });

    // Inbound call arrival
    window.VobizSip.on("incoming", (data) => {
      incomingPending = true;
      currentCallDirection = "Inbound";
      incomingCallerNumber = data.number || "Unknown caller";
      setStatus(`Incoming call from ${incomingCallerNumber}`, "busy");
      showIncomingBanner(incomingCallerNumber);
      startRingtone();
      log(`Incoming call ringing from ${incomingCallerNumber}`, "warning");
    });

    // Call Termination (Ended or Failed)
    const handleCallTermination = (detail) => {
      const isWasInbound = currentCallDirection === "Inbound";
      const finalDuration = secondsElapsed;
      const finalCaller = incomingCallerNumber || (dialInput ? dialInput.value.trim() : "Unknown");

      stopCallTimer();
      hideIncomingBanner();
      setHangupVisible(false);
      resetCallControls();
      setStatus("Ready", "ok");

      if (callStatusText) callStatusText.textContent = "Call ended";
      setTimeout(() => { if (callNumEl) callNumEl.hidden = true; }, 3500);

      log(`Call terminated (${finalDuration}s). Syncing CDR to Pipedrive…`, "info");
      setTimeout(loadCallRecordings, 5000);

      // Trigger Inbound Call Done Popup Notification!
      if (isWasInbound) {
        showInboundCallDoneNotification(finalCaller, finalDuration);
      }
    };

    window.VobizSip.on("ended", handleCallTermination);
    window.VobizSip.on("failed", (cause) => {
      log(`Call failed: ${cause}`, "error");
      handleCallTermination(cause);
    });
  }

  // ─── Dual Login Handlers ──────────────────────────────────────────────────

  // Mode 1: Vobiz Account Login
  async function vobizAccountLogin() {
    const authId = authIdInput ? authIdInput.value.trim() : "";
    const authToken = authTokenInput ? authTokenInput.value.trim() : "";
    const agentId = agentSelect ? agentSelect.value : "admin";

    if (!authId || !authToken) {
      setLoginStatus("Enter both VoBiz Auth ID and Auth Token.");
      return;
    }

    if (authId.includes("@")) {
      setLoginStatus("You entered an email address. Auth ID is an API identifier (e.g. MA_XXXXXXXX or SA_XXXXXXXX), not your console email. Switch to the 'SIP direct' tab to log in with an endpoint, or find your Auth ID in Console > API credentials.");
      setStatus("Invalid Auth ID", "error");
      if (accountLoginBtn) accountLoginBtn.disabled = false;
      return;
    }

    setLoginStatus("Signing in to VoBiz…");
    setStatus("Authenticating…", "pending");
    if (accountLoginBtn) accountLoginBtn.disabled = true;

    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ authId, authToken, agentId })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          authId: data.authId,
          token: data.token,
          agentId: data.agent.id,
          agentName: data.agent.name,
          numbers: data.numbers || [],
          selected: data.selected || ""
        }));

        accountReady = true;
        renderNumberOptions(data.numbers || [], data.selected || "");
        setLoginStatus(`Signed in as ${data.authId}`);
        if (logoutBtn) logoutBtn.classList.remove("hidden");
        updateDialButtonState();
        log(`VoBiz Account signed in (${data.authId})`, "success");

        // Connect SIP using account session
        window.VobizSip.connect({
          token: data.token,
          audioElement: remoteAudio,
          backendUrl: ""
        });

        loadCallRecordings();
      } else {
        setLoginStatus(`Login failed: ${data.error || "Check credentials"}`);
        setStatus("Login failed", "error");
        accountReady = false;
        updateDialButtonState();
      }
    } catch (err) {
      setLoginStatus(`Network error: ${err.message}`);
      setStatus("Offline", "error");
      accountReady = false;
      updateDialButtonState();
    } finally {
      if (accountLoginBtn) accountLoginBtn.disabled = false;
    }
  }

  // Mode 2: SIP Direct Login
  async function sipDirectConnect() {
    const username = sipUserInput ? sipUserInput.value.trim() : "";
    const password = sipPassInput ? sipPassInput.value : "";
    const callerId = sipCallerIdInput ? sipCallerIdInput.value.trim() : "";
    const remember = Boolean(sipRememberCheck && sipRememberCheck.checked);

    if (!username || !password) {
      setLoginStatus("Enter endpoint SIP username and password.");
      return;
    }
    if (!callerId) {
      setLoginStatus("Enter a caller ID number (e.g. +91XXXXXXXXXX).");
      return;
    }

    if (remember) {
      // Username and caller ID only. A SIP password in localStorage is readable
      // by any script on this origin and outlives the session.
      localStorage.setItem(SIP_CREDS_KEY, JSON.stringify({ username, callerId }));
    } else {
      localStorage.removeItem(SIP_CREDS_KEY);
    }

    const cleanUsername = username.includes("@") ? username.split("@")[0] : username;
    setLoginStatus(`Connecting as ${cleanUsername}…`);
    setStatus(`Connecting as ${cleanUsername}…`, "pending");

    // The caller ID travels with each call as an X-VH-Caller-ID SIP header,
    // so the backend needs no per-user state for it.
    accountReady = true;
    if (logoutBtn) logoutBtn.classList.remove("hidden");
    updateDialButtonState();

    // Connect SIP UA directly
    window.VobizSip.connectDirect({
      sipUser: cleanUsername,
      sipPassword: password,
      displayName: cleanUsername,
      audioElement: remoteAudio
    });

    log(`SIP direct connecting for endpoint: ${cleanUsername} with Caller ID: ${callerId}`, "info");
    loadCallRecordings();
  }

  function handleLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SIP_CREDS_KEY);
    accountReady = false;
    sipRegistered = false;
    if (window.VobizSip) window.VobizSip.disconnect();
    if (logoutBtn) logoutBtn.classList.add("hidden");
    setLoginStatus("Not signed in.");
    setStatus("Offline", "error");
    updateDialButtonState();
    log("Signed out of softphone.", "info");
  }

  if (accountLoginBtn) accountLoginBtn.addEventListener("click", vobizAccountLogin);
  if (sipConnectBtn) sipConnectBtn.addEventListener("click", sipDirectConnect);
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);

  // Restore saved sessions / auth modes on load
  function restoreSession() {
    registerSipEvents();

    const savedMode = localStorage.getItem(AUTH_MODE_KEY) || "account";
    setAuthMode(savedMode);

    if (savedMode === "sip") {
      try {
        const saved = JSON.parse(localStorage.getItem(SIP_CREDS_KEY) || "null");
        if (saved && saved.username) {
          if (sipUserInput) sipUserInput.value = saved.username;
          if (sipCallerIdInput) sipCallerIdInput.value = saved.callerId || "";
          if (sipRememberCheck) sipRememberCheck.checked = true;
        }
      } catch (e) { /* ignore */ }
    } else {
      try {
        const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
        if (session && session.token) {
          accountReady = true;
          renderNumberOptions(session.numbers || [], session.selected || "");
          setLoginStatus(`Signed in as ${session.authId}`);
          if (logoutBtn) logoutBtn.classList.remove("hidden");
          updateDialButtonState();
          window.VobizSip.connect({
            token: session.token,
            audioElement: remoteAudio
          });
          loadCallRecordings();
          return;
        }
      } catch (e) { /* ignore */ }
    }

    setStatus("Not signed in", "pending");
    updateDialButtonState();
  }

  function renderNumberOptions(numbers, selected) {
    if (!numberSelect) return;
    numberSelect.innerHTML = "";
    if (!numbers || !numbers.length) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = "No numbers found on account";
      numberSelect.appendChild(opt);
      return;
    }
    numbers.forEach(num => {
      const opt = document.createElement("option");
      opt.value = num;
      opt.textContent = num;
      if (num === selected) opt.selected = true;
      numberSelect.appendChild(opt);
    });
  }

  // ─── Outbound Calling ─────────────────────────────────────────────────────

  function getEffectiveCallerId() {
    if (authMode === "sip") {
      return (sipCallerIdInput && sipCallerIdInput.value.trim()) || "";
    }
    return (numberSelect && numberSelect.value) || "";
  }

  async function placeCall() {
    const rawNumber = dialInput ? dialInput.value.trim() : "";
    if (!rawNumber) {
      if (dialHint) dialHint.textContent = "Please enter a phone number to call.";
      return;
    }

    if (!sipRegistered) {
      if (dialHint) dialHint.textContent = "SIP phone not registered yet. Please wait.";
      return;
    }

    currentCallDirection = "Outbound";
    currentCallStartTime = Date.now();
    const callerId = getEffectiveCallerId();
    const extraHeaders = callerId ? [`X-VH-Caller-ID: ${callerId.replace(/[^\d+]/g, "")}`] : [];

    log(`Dialing ${rawNumber} (Caller ID: ${callerId || 'Default'})…`, "info");
    setHangupVisible(true);
    setStatus("Dialing…", "busy");
    if (callStatusText) callStatusText.textContent = `Calling ${rawNumber}…`;
    if (callNumEl) callNumEl.hidden = false;

    lookupPipedriveContact(rawNumber);

    const session = window.VobizSip.call(rawNumber, remoteAudio, extraHeaders);
    if (!session) {
      setHangupVisible(false);
      setStatus("Call failed", "error");
      log("Could not initiate call.", "error");
    }
  }

  function hangUp() {
    if (window.VobizSip) {
      window.VobizSip.hangup();
    }
    setHangupVisible(false);
    stopCallTimer();
    resetCallControls();
    setStatus("Ready", "ok");
    log("Call ended by agent.", "info");
  }

  if (dialBtn) dialBtn.addEventListener("click", placeCall);
  if (hangupBtn) hangupBtn.addEventListener("click", hangUp);

  if (dialInput) {
    dialInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") placeCall();
    });
    dialInput.addEventListener("input", () => {
      lookupPipedriveContact(dialInput.value.trim());
    });
  }

  // Keypad button clicks
  document.querySelectorAll(".keypad-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-key");
      if (dialInput) {
        dialInput.value += key;
        lookupPipedriveContact(dialInput.value.trim());
      }
      if (window.VobizSip && window.VobizSip.hasActiveCall()) {
        window.VobizSip.sendDTMF(key);
      }
    });
  });

  // ─── Call Controls (Mute, Hold, Transfer) ──────────────────────────────────

  function resetCallControls() {
    isMuted = false;
    isOnHold = false;
    if (muteBtn) {
      muteBtn.classList.remove("is-active");
      muteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg> Mute`;
    }
    if (holdBtn) {
      holdBtn.classList.remove("is-active");
      holdBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Hold`;
    }
  }

  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      isMuted = !isMuted;
      window.VobizSip.setMuted(isMuted);
      muteBtn.classList.toggle("is-active", isMuted);
      muteBtn.innerHTML = isMuted
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/></svg> Unmute`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg> Mute`;
      log(isMuted ? "Microphone muted" : "Microphone unmuted", "info");
    });
  }

  if (holdBtn) {
    holdBtn.addEventListener("click", () => {
      isOnHold = !isOnHold;
      window.VobizSip.setHold(isOnHold);
      holdBtn.classList.toggle("is-active", isOnHold);
      holdBtn.innerHTML = isOnHold
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Hold`;
      log(isOnHold ? "Call on hold" : "Call resumed", "info");
    });
  }

  // ─── Pipedrive Contact Lookup ─────────────────────────────────────────────

  async function lookupPipedriveContact(phone) {
    if (!phone || phone.length < 5) {
      if (contactBox) contactBox.classList.add("hidden");
      return;
    }

    try {
      const res = await fetch(`/api/pipedrive/persons/lookup?phone=${encodeURIComponent(phone)}`, { headers: authHeaders() });
      if (res.ok) {
        const contact = await res.json();
        if (contact && contact.name) {
          if (contactBox) contactBox.classList.remove("hidden");
          if (pdContactName) pdContactName.textContent = contact.name;
          if (pdContactPhone) pdContactPhone.textContent = phone;
          if (pdContactEmail) pdContactEmail.textContent = contact.email || "";
          if (pdContactOrg) pdContactOrg.textContent = contact.organization || "";
          if (pdDealTag) {
            if (contact.deal_title) {
              pdDealTag.textContent = `Deal: ${contact.deal_title}`;
              pdDealTag.classList.remove("hidden");
            } else {
              pdDealTag.classList.add("hidden");
            }
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  if (refreshContactBtn) {
    refreshContactBtn.addEventListener("click", () => {
      if (dialInput) lookupPipedriveContact(dialInput.value.trim());
    });
  }

  // ─── Call Recordings List & Playback ──────────────────────────────────────

  async function loadCallRecordings() {
    if (!historyList) return;
    historyList.innerHTML = `<li class="history-empty">Loading recent recordings…</li>`;

    try {
      if (!authHeaders().Authorization) {
        historyList.innerHTML = `<li class="history-empty">Sign in with your Vobiz account to see recordings.</li>`;
        return;
      }
      const res = await fetch("/recordings?limit=10", { headers: authHeaders() });
      const data = await res.json();
      const list = (data && (data.recordings || data.objects)) || [];

      if (!list.length) {
        historyList.innerHTML = `<li class="history-empty">No recordings found. Completed calls will appear here.</li>`;
        return;
      }

      historyList.innerHTML = "";
      list.forEach((rec) => {
        const li = document.createElement("li");
        li.className = "history-item";

        const top = document.createElement("div");
        top.className = "history-top";

        const timeSpan = document.createElement("span");
        timeSpan.textContent = rec.add_time || "Recent call";

        const durSpan = document.createElement("span");
        durSpan.className = "history-dur";
        durSpan.textContent = formatDuration(rec.rounded_recording_duration || rec.duration || 0);

        top.appendChild(timeSpan);
        top.appendChild(durSpan);

        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.className = "history-audio";
        if (!rec.playUrl) return;
        audio.src = rec.playUrl;

        li.appendChild(top);
        li.appendChild(audio);
        historyList.appendChild(li);
      });
    } catch (err) {
      historyList.innerHTML = `<li class="history-empty">Recordings unavailable (${err.message}).</li>`;
    }
  }

  if (refreshHistoryBtn) refreshHistoryBtn.addEventListener("click", loadCallRecordings);

  // Initialize
  restoreSession();
});

