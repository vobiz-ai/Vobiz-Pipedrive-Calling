/** === Vobiz SIP layer for the Pipedrive softphone ===
 *
 * THE BROWSER IS THE A LEG.
 * Supports dual connect:
 * 1. connect({ token, audioElement, backendUrl }) - Account mode
 * 2. connectDirect({ sipUser, sipPassword, displayName, registrarUrl, audioElement }) - SIP direct mode
 *
 * Exposes window.VobizSip.
 */
(function () {
  "use strict";

  const REGISTRAR_HOST = "registrar.vobiz.ai";

  let ua = null;
  let session = null;
  let registered = false;
  let identity = null;
  let remoteAudioElement = null;
  const listeners = {};

  function emit(event, payload) {
    (listeners[event] || []).forEach((fn) => {
      try { fn(payload); } catch (err) { console.error(`[VobizSip] ${event} handler threw:`, err); }
    });
  }

  function on(event, fn) {
    (listeners[event] = listeners[event] || []).push(fn);
  }

  function attachAudio(s, audioEl) {
    const el = audioEl || remoteAudioElement;
    if (!el) return;
    const bind = (pc) => {
      if (!pc) return;
      pc.addEventListener("track", (event) => {
        el.srcObject = event.streams[0];
        el.play().catch((err) => console.warn("[VobizSip] autoplay blocked:", err));
      });
    };
    s.on("peerconnection", (e) => bind(e.peerconnection));
    if (s.connection) bind(s.connection);
  }

  function initUA(creds, audioEl) {
    if (audioEl) remoteAudioElement = audioEl;

    if (ua) {
      try { ua.removeAllListeners(); } catch { /* ignore */ }
      try { ua.stop(); } catch { /* ignore */ }
      ua = null;
    }

    identity = creds;
    const cleanUri = creds.sipUser.startsWith("sip:") ? creds.sipUser : `sip:${creds.sipUser}`;
    const regUrl = creds.registrarUrl || `wss://${REGISTRAR_HOST}:5063/`;
    const socket = new JsSIP.WebSocketInterface(regUrl);

    ua = new JsSIP.UA({
      sockets: [socket],
      uri: cleanUri,
      password: creds.sipPassword,
      display_name: creds.displayName || creds.sipUser,
      register: true,
      session_timers: false,
      user_agent: "VobizPipedriveCalling/2.0.0",
    });

    ua.on("registered", () => {
      registered = true;
      emit("registered", identity);
    });

    ua.on("unregistered", () => {
      registered = false;
      emit("unregistered");
    });

    ua.on("disconnected", () => {
      registered = false;
      emit("disconnected");
    });

    ua.on("registrationFailed", (e) => {
      registered = false;
      emit("registrationFailed", (e && e.cause) || "unknown");
    });

    ua.on("newRTCSession", (data) => {
      if (data.originator !== "remote") return;
      session = data.session;
      const from = (session.remote_identity && session.remote_identity.uri && session.remote_identity.uri.user) || "Unknown caller";
      
      const onEnded = () => {
        session = null;
        emit("ended", { originator: "remote" });
      };
      const onFailed = (e) => {
        session = null;
        emit("failed", (e && e.cause) || "unknown");
      };

      session.on("progress", () => emit("progress"));
      session.on("confirmed", () => emit("confirmed"));
      session.on("ended", onEnded);
      session.on("failed", onFailed);

      emit("incoming", {
        number: from,
        session,
        answer: (customAudio) => answerCall(customAudio),
        decline: () => declineCall()
      });
    });

    ua.start();
    return true;
  }

  async function connect({ token, audioElement, backendUrl = "" }) {
    if (typeof JsSIP === "undefined") {
      emit("error", new Error("JsSIP failed to load — agent-phone/lib/jssip.min.js is missing or blocked"));
      return false;
    }

    let creds;
    try {
      const res = await fetch(`${backendUrl}/api/agent-sip`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      creds = await res.json();
      if (!res.ok) throw new Error(creds.error || `HTTP ${res.status}`);
    } catch (err) {
      emit("error", err);
      return false;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      emit("error", new Error("No microphone access in this context — calls cannot connect"));
      return false;
    }

    return initUA(creds, audioElement);
  }

  function connectDirect({ sipUser, sipPassword, displayName, registrarUrl, audioElement }) {
    if (typeof JsSIP === "undefined") {
      emit("error", new Error("JsSIP failed to load — agent-phone/lib/jssip.min.js is missing or blocked"));
      return false;
    }

    const cleanUser = sipUser.includes("@") ? sipUser : `${sipUser}@${REGISTRAR_HOST}`;
    const creds = {
      sipUser: cleanUser,
      sipPassword,
      displayName: displayName || sipUser,
      registrarUrl: registrarUrl || `wss://${REGISTRAR_HOST}:5063/`
    };

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      emit("error", new Error("No microphone access in this context — calls cannot connect"));
      return false;
    }

    return initUA(creds, audioElement);
  }

  function bindSession(s) {
    s.on("progress", () => emit("progress"));
    s.on("confirmed", () => emit("confirmed"));
    s.on("ended", () => { session = null; emit("ended"); });
    s.on("failed", (e) => { session = null; emit("failed", (e && e.cause) || "unknown"); });
  }

  function call(number, audioElement, extraHeaders = []) {
    if (!ua || !registered) {
      emit("error", new Error("Not registered yet — wait for the status to read Ready"));
      return null;
    }
    if (session) {
      emit("error", new Error("Already on a call"));
      return null;
    }
    const cleanNumber = String(number).replace(/[^\d+]/g, "");
    const target = `sip:${cleanNumber}@${REGISTRAR_HOST}`;
    try {
      session = ua.call(target, {
        extraHeaders: Array.isArray(extraHeaders) ? extraHeaders : [],
        mediaConstraints: { audio: true, video: false },
        pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
        sessionTimersExpires: 300,
      });
      attachAudio(session, audioElement || remoteAudioElement);
      bindSession(session);
      return session;
    } catch (err) {
      emit("error", err);
      session = null;
      return null;
    }
  }

  function answerCall(customAudio) {
    if (!session) return false;
    try {
      attachAudio(session, customAudio || remoteAudioElement);
      session.answer({
        mediaConstraints: { audio: true, video: false },
        pcConfig: { iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }] },
        sessionTimersExpires: 300,
      });
      return true;
    } catch (err) {
      emit("error", err);
      try { session.terminate(); } catch { /* ignore */ }
      session = null;
      return false;
    }
  }

  function declineCall() {
    if (!session) return false;
    try {
      session.terminate();
    } catch (err) {
      console.warn("[VobizSip] decline failed:", err);
    }
    session = null;
    return true;
  }

  function hangup() {
    if (!session) return false;
    try { session.terminate(); } catch (err) { console.warn("[VobizSip] hangup failed:", err); }
    session = null;
    return true;
  }

  function setMuted(muted) {
    if (!session) return false;
    try { muted ? session.mute({ audio: true }) : session.unmute({ audio: true }); return true; }
    catch (err) { console.warn("[VobizSip] mute failed:", err); return false; }
  }

  function setHold(held) {
    if (!session) return false;
    try { held ? session.hold() : session.unhold(); return true; }
    catch (err) { console.warn("[VobizSip] hold failed:", err); return false; }
  }

  function sendDTMF(key) {
    if (!session || !session.isEstablished || !session.isEstablished()) return false;
    try { session.sendDTMF(key); return true; } catch (err) { return false; }
  }

  function disconnect() {
    try { if (ua) ua.stop(); } catch (err) { /* ignore */ }
    ua = null; session = null; registered = false;
  }

  window.VobizSip = {
    on, connect, connectDirect, call, answer: answerCall, decline: declineCall, hangup,
    setMuted, setHold, sendDTMF, disconnect,
    isRegistered: () => registered,
    hasActiveCall: () => Boolean(session),
    identity: () => identity,
    getSession: () => session,
  };
})();
