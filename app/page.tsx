"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Status = "idle" | "listening" | "thinking" | "answering" | "error";
type Message = { type: string; [key: string]: unknown };
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8787";

export default function Home() {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [resume, setResume] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [mode, setMode] = useState("concise");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);

  const socketRef = useRef<WebSocket | null>(null);
  const mediaRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const shouldContinueRecordingRef = useRef(false);
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioLevelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const segmentHadSpeechRef = useRef(false);
  const segmentDurationMs = 3500;
  const speechRmsThreshold = 0.012;

  function mergeTranscript(previous: string, incoming: string) {
    const next = incoming.replace(/\s+/g, " ").trim();
    if (!next) return previous;
    if (!previous.trim()) return next;
    const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
    const a = words(previous), b = words(next);
    if (a.join(" ").includes(b.join(" "))) return previous;
    for (let n = Math.min(12, a.length, b.length); n >= 3; n--) {
      if (a.slice(-n).every((w, i) => w === b[i])) {
        const remainder = next.split(/\s+/).slice(n).join(" ").trim();
        return remainder ? `${previous.trim()} ${remainder}` : previous;
      }
    }
    return `${previous.trim()} ${next}`;
  }

  const handleMessage = useCallback((event: MessageEvent) => {
    let msg: Message;
    try { msg = JSON.parse(String(event.data)) as Message; } catch { return; }
    if (msg.type === "ready") setConnected(true);
    if (msg.type === "transcript") {
      const text = String(msg.text || "");
      if (msg.isFinal) {
        if (text.trim()) setTranscript((prev) => mergeTranscript(prev, text));
        setInterim("");
      } else setInterim(text);
    }
    if (msg.type === "question") {
      setQuestion(String(msg.text || ""));
      setAnswer("");
      setStatus("thinking");
    }
    if (msg.type === "answer-start") {
      setAnswer("");
      setStatus("answering");
    }
    if (msg.type === "answer-token") setAnswer((prev) => prev + String(msg.text || ""));
    if (msg.type === "answer-done") setStatus("listening");
    if (msg.type === "status" && msg.status === "thinking") setStatus("thinking");
    if (msg.type === "error") {
      setError(String(msg.message || "An unexpected error occurred."));
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const ws = new WebSocket(WS_URL);
    socketRef.current = ws;
    ws.onopen = () => setConnected(true);
    ws.onmessage = handleMessage;
    ws.onerror = () => {
      setError("Cannot connect to the backend. Check that the server is running.");
      setStatus("error");
    };
    ws.onclose = () => setConnected(false);
    return () => {
      shouldContinueRecordingRef.current = false;
      if (segmentTimerRef.current) clearTimeout(segmentTimerRef.current);
      if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
      if (recorderRef.current?.state !== "inactive") recorderRef.current?.stop();
      mediaRef.current?.getTracks().forEach((t) => t.stop());
      void audioContextRef.current?.close();
      ws.close();
    };
  }, [handleMessage]);

  function clearSegmentTimer() {
    if (segmentTimerRef.current) clearTimeout(segmentTimerRef.current);
    segmentTimerRef.current = null;
  }
  function clearAudioLevelTimer() {
    if (audioLevelTimerRef.current) clearInterval(audioLevelTimerRef.current);
    audioLevelTimerRef.current = null;
  }
  function startAudioLevelMeter(stream: MediaStream) {
    const audioContext = new window.AudioContext();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = audioContext;
    analyserRef.current = analyser;
    const samples = new Uint8Array(analyser.fftSize);
    clearAudioLevelTimer();
    audioLevelTimerRef.current = setInterval(() => {
      const activeAnalyser = analyserRef.current;
      if (!activeAnalyser) return;
      activeAnalyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const value = (sample - 128) / 128;
        sum += value * value;
      }
      if (Math.sqrt(sum / samples.length) > speechRmsThreshold) segmentHadSpeechRef.current = true;
    }, 100);
  }
  function recordNextSegment(stream: MediaStream, mimeType: string) {
    const ws = socketRef.current;
    if (!shouldContinueRecordingRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    chunksRef.current = [];
    segmentHadSpeechRef.current = false;
    recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
    recorder.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      if (segmentHadSpeechRef.current && blob.size > 1000 && socketRef.current?.readyState === WebSocket.OPEN) {
        try {
          const bytes = await blob.arrayBuffer();
          if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(bytes);
        } catch {
          setError("Could not prepare an audio segment. Please stop and try again.");
        }
      }
      if (shouldContinueRecordingRef.current) recordNextSegment(stream, mimeType);
      else if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "stop" }));
    };
    recorder.start();
    clearSegmentTimer();
    segmentTimerRef.current = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, segmentDurationMs);
  }
  async function startListening() {
    setError("");
    setTranscript("");
    setInterim("");
    setQuestion("");
    setAnswer("");
    const ws = socketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setError("Backend WebSocket is not connected. Start the backend and try again.");
      setStatus("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      mediaRef.current = stream;
      startAudioLevelMeter(stream);
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
      ws.send(JSON.stringify({ type: "start", resume, jobDescription, mode }));
      shouldContinueRecordingRef.current = true;
      setStatus("listening");
      recordNextSegment(stream, mimeType);
    } catch (e) {
      shouldContinueRecordingRef.current = false;
      setError(e instanceof Error ? e.message : "Microphone permission was denied.");
      setStatus("error");
    }
  }
  function stopListening() {
    shouldContinueRecordingRef.current = false;
    clearSegmentTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify({ type: "stop" }));
    recorderRef.current = null;
    mediaRef.current?.getTracks().forEach((track) => track.stop());
    mediaRef.current = null;
    clearAudioLevelTimer();
    analyserRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    setStatus("idle");
    setInterim("");
  }
  function askManualQuestion() {
    const q = window.prompt("Enter the interview question:");
    if (q?.trim() && socketRef.current?.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type: "manual-question", text: q.trim(), resume, jobDescription, mode }));
    }
  }
  const active = status === "listening" || status === "thinking" || status === "answering";
  const statusLabel = { idle: "Ready to begin", listening: "Listening live", thinking: "Preparing answer", answering: "Generating answer", error: "Needs attention" }[status];
  const wordCount = transcript.trim() ? transcript.trim().split(/\s+/).length : 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon"><span>ic</span></div>
          <div><strong>Interview<span>Copilot</span></strong><small>AI WORKSPACE</small></div>
        </div>
        <div className="side-label">WORKSPACE</div>
        <div className="nav-item selected"><span className="nav-icon">◫</span> Live assistant <span className="nav-indicator" /></div>
        <div className="nav-item"><span className="nav-icon">▤</span> Interview context</div>
        <div className="sidebar-bottom">
          <div className="privacy-icon">✦</div>
          <strong>Your interview, organized.</strong>
          <p>Keep context close and answers easy to review.</p>
          <div className="sidebar-foot"><span className={`connection-dot ${connected ? "online" : ""}`} />{connected ? "Backend connected" : "Connecting to backend"}</div>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> <strong>Live assistant</strong></div>
          <div className="topbar-right"><span className={`connection-pill ${connected ? "connected" : ""}`}><i />{connected ? "System connected" : "Connecting…"}</span><div className="avatar">IC</div></div>
        </header>

        <div className="page-content">
          <section className="hero">
            <div>
              <div className="eyebrow"><span className="eyebrow-spark">✦</span> REAL-TIME INTERVIEW SUPPORT</div>
              <h1>Make every answer <span>count.</span></h1>
              <p>Listen to the conversation, catch the question, and get a clear answer to build on.</p>
            </div>
            <div className={`status-card ${status}`}><span className="status-orb"><i /></span><div><small>SESSION STATUS</small><strong>{statusLabel}</strong></div></div>
          </section>

          <section className="context-panel panel">
            <div className="panel-heading">
              <div className="heading-icon context-icon">▤</div>
              <div className="heading-copy"><h2>Interview context</h2><p>Personalize suggestions with your background and target role.</p></div>
              <span className="optional-tag">OPTIONAL · RECOMMENDED</span>
            </div>
            <div className="context-fields">
              <label className="field"><span>Resume or professional summary</span><textarea value={resume} onChange={(e) => setResume(e.target.value)} placeholder="Add your skills, experience, projects, and achievements…" rows={4} /></label>
              <label className="field"><span>Job description</span><textarea value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} placeholder="Paste the role, requirements, and responsibilities…" rows={4} /></label>
            </div>
            <div className="context-actions">
              <label className="select-field"><span>Answer style</span><select value={mode} onChange={(e) => setMode(e.target.value)}><option value="concise">Concise and clear</option><option value="detailed">Detailed explanation</option><option value="star">STAR · behavioral</option></select></label>
              <div className="action-buttons">
                <button className="button button-quiet" onClick={askManualQuestion}><span>✧</span> Try sample question</button>
                {active ? <button className="button button-stop" onClick={stopListening}><span className="stop-square" /> Stop listening</button> : <button className="button button-primary" onClick={startListening} disabled={!connected}><span className="mic-icon">●</span> Start listening <span className="button-arrow">→</span></button>}
              </div>
            </div>
          </section>

          {error && <div className="error-banner" role="alert"><span>!</span><p>{error}</p><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

          <div className="section-title"><div><span className="section-kicker">LIVE SESSION</span><h2>Your interview workspace</h2></div><span className="live-badge"><i /> {active ? "SESSION ACTIVE" : "READY WHEN YOU ARE"}</span></div>
          <section className="workspace-grid">
            <article className="panel transcript-panel">
              <div className="panel-heading compact">
                <div className="heading-icon transcript-icon">≋</div>
                <div className="heading-copy"><h2>Live transcript</h2><p>Speech converted into text</p></div>
                <span className="live-mini"><i /> LIVE</span>
              </div>
              <div className="transcript-content">
                {transcript || interim ? <p>{transcript}{transcript && interim ? " " : ""}<span className="interim-text">{interim}</span></p> : <div className="empty-state"><div className="empty-illustration waveform"><span /><span /><span /><span /><span /><span /><span /><span /><span /></div><strong>Your conversation starts here</strong><p>Start listening, then speak naturally. Your transcript will appear in this panel.</p></div>}
              </div>
              <div className="panel-footer"><span><strong>{wordCount}</strong> final words</span><button className="text-button" onClick={() => { setTranscript(""); setInterim(""); }}>Clear transcript</button></div>
            </article>

            <div className="answer-column">
              <article className="panel question-panel">
                <div className="panel-heading compact">
                  <div className="heading-icon question-icon">?</div>
                  <div className="heading-copy"><h2>Detected question</h2><p>Latest interviewer question</p></div>
                  <span className="step-chip">01</span>
                </div>
                <div className="question-content">{question ? <p>{question}</p> : <div className="question-placeholder"><span>↳</span><p>A complete question will appear here when detected.</p></div>}</div>
              </article>
              <article className="panel answer-panel">
                <div className="panel-heading compact">
                  <div className="heading-icon answer-icon">✦</div>
                  <div className="heading-copy"><h2>Suggested answer</h2><p>Concise, contextual talking points</p></div>
                  <span className="ai-label">AI POWERED</span>
                </div>
                <div className="answer-content">
                  {answer ? <div className="answer-text">{answer}</div> : <div className="empty-state answer-empty"><div className="answer-spark">✦</div><strong>{status === "thinking" ? "Thinking through the question…" : status === "answering" ? "Preparing your answer…" : "Your answer, at a glance"}</strong><p>Suggested talking points will show here as they are generated.</p></div>}
                </div>
                {answer && <div className="answer-footer"><span>Review and adapt to your own experience.</span><button className="text-button" onClick={() => navigator.clipboard?.writeText(answer)}>Copy answer ↗</button></div>}
              </article>
            </div>
          </section>

          <footer className="page-footer"><span>✦ Interview Copilot <em>POC</em></span><span>AI suggestions are a starting point. Review answers before using them.</span></footer>
        </div>
      </section>
    </main>
  );
}
