import "dotenv/config";
import http from "node:http";
import WebSocket, { WebSocketServer } from "ws";
import Groq from "groq-sdk";

const PORT = Number(process.env.PORT || 8787);
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ name: "Interview Copilot WebSocket server", status: "ok" }));
});
const wss = new WebSocketServer({ server });

type Context = { resume?: string; jobDescription?: string; mode?: string; history?: string[] };
function send(ws: WebSocket, data: Record<string, unknown>) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function normalize(s: string) {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
function isSmallTalk(s: string) {
  const t = normalize(s);
  return !t || /^(hello|hi|hey|thanks|thank you|okay|ok|right|great|nice|can you hear me|let me think)$/.test(t)
    || t.includes("why are you repeating this question")
    || t.includes("why are you repeating the question");
}
function extractQuestion(text: string): string | null {
  const starters = /^(tell me|describe|explain|walk me through|what|why|how|when|where|which|who|can you|could you|have you|do you|did you|would you|give me|share|talk about|in your experience)\b/i;
  const sentences = text.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)
    .map(s => s.trim()).filter(s => s.length >= 12 && !isSmallTalk(s));
  const found = sentences.filter(s => s.includes("?") || starters.test(s));
  if (!found.length) return null;
  return found[found.length - 1].slice(-280);
}
function removeOverlap(previous: string, incoming: string) {
  const next = incoming.replace(/\s+/g, " ").trim();
  if (!next) return "";
  const a = previous.trim().split(/\s+/).filter(Boolean);
  const b = next.split(/\s+/).filter(Boolean);
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  for (let n = Math.min(12, a.length, b.length); n >= 3; n--) {
    if (a.slice(-n).map(norm).every((w, i) => w && w === norm(b[i]))) return b.slice(n).join(" ").trim();
  }
  return next;
}
async function answerQuestion(ws: WebSocket, question: string, ctx: Context) {
  if (!groq) {
    send(ws, { type: "error", message: "GROQ_API_KEY is missing. Add it to .env and restart the backend." });
    return;
  }
  send(ws, { type: "question", text: question });
  send(ws, { type: "status", status: "thinking" });
  const style = ctx.mode === "star"
    ? "Use STAR for behavioral questions; otherwise answer normally."
    : ctx.mode === "detailed" ? "Use up to 6 concise bullets and at most 120 words."
    : "Use 3–6 concise bullets or about 60–90 words.";
  const system = `You are a real-time interview answer coach. Answer only the interview question directly and naturally. ${style} Use the candidate resume and job description. Never invent personal experience, employers, skills, metrics, or achievements. Do not use placeholders. If context is missing, give a general honest answer. Plain text only.`;
  const user = `RESUME:\n${(ctx.resume || "(Not provided)").slice(0,12000)}\n\nJOB DESCRIPTION:\n${(ctx.jobDescription || "(Not provided)").slice(0,12000)}\n\nRECENT Q&A:\n${(ctx.history || []).slice(-4).join("\n") || "(None)"}\n\nQUESTION:\n${question}`;
  try {
    const stream = await groq.chat.completions.create({
      model: GROQ_MODEL, stream: true, temperature: 0.3, max_tokens: 240,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    });
    send(ws, { type: "answer-start" });
    let full = "";
    for await (const chunk of stream) {
      const token = chunk.choices[0]?.delta?.content;
      if (typeof token === "string" && token) { full += token; send(ws, { type: "answer-token", text: token }); }
    }
    send(ws, { type: "answer-done" });
    ctx.history = [...(ctx.history || []), `Q: ${question}\nA: ${full}`].slice(-8);
  } catch (e) {
    send(ws, { type: "error", message: `Groq answer request failed: ${e instanceof Error ? e.message : "Unknown error"}` });
  }
}

wss.on("connection", client => {
  let active = false;
  let ctx: Context = {};
  let queue: Buffer[] = [];
  let processing = false;
  let stopping = false;
  let allTranscript = "";
  let utterance: string[] = [];
  let detectTimer: ReturnType<typeof setTimeout> | undefined;
  let lastQuestion = "";
  let lastQuestionAt = 0;
  send(client, { type: "connected" });

  function clearDetectTimer() {
    if (detectTimer) clearTimeout(detectTimer);
    detectTimer = undefined;
  }
  function scheduleDetection() {
    clearDetectTimer();
    detectTimer = setTimeout(() => {
      detectTimer = undefined;
      const q = extractQuestion(utterance.join(" "));
      utterance = [];
      if (!q) return;
      const n = normalize(q);
      if (n === normalize(lastQuestion) && Date.now() - lastQuestionAt < 15000) return;
      lastQuestion = q;
      lastQuestionAt = Date.now();
      void answerQuestion(client, q, ctx);
    }, 950);
  }
  async function transcribe(segment: Buffer) {
    if (!groq || segment.length < 1000) return;
    try {
      const file = new File([new Uint8Array(segment)], `audio-${Date.now()}.webm`, { type: "audio/webm" });
      // Ask Whisper for segment-level confidence signals to reject likely
      // silence/background-noise hallucinations.
      const result = await groq.audio.transcriptions.create({
        file,
        model: GROQ_STT_MODEL,
        language: "en",
        response_format: "verbose_json",
        temperature: 0,
      });
      const transcription = result as unknown as {
        text?: string;
        segments?: Array<{
          no_speech_prob?: number;
          avg_logprob?: number;
          compression_ratio?: number;
        }>;
      };
      const text = (transcription.text || "").replace(/\s+/g, " ").trim();
      if (!text) return;

      const segments = transcription.segments || [];
      if (segments.length) {
        const noSpeech = segments.map(s => s.no_speech_prob).filter((v): v is number => typeof v === "number");
        const logProbs = segments.map(s => s.avg_logprob).filter((v): v is number => typeof v === "number");
        const compressions = segments.map(s => s.compression_ratio).filter((v): v is number => typeof v === "number");
        const avgNoSpeech = noSpeech.length ? noSpeech.reduce((a, b) => a + b, 0) / noSpeech.length : 0;
        const avgLogProb = logProbs.length ? logProbs.reduce((a, b) => a + b, 0) / logProbs.length : 0;
        const maxCompression = compressions.length ? Math.max(...compressions) : 0;

        // no_speech_prob alone can be noisy. Reject only strong silence evidence,
        // or a combination of weak confidence and likely non-speech.
        if (
          avgNoSpeech > 0.85 ||
          (avgNoSpeech > 0.45 && avgLogProb < -1.1) ||
          (avgLogProb < -1.5 && maxCompression > 2.8) ||
          maxCompression > 3.5
        ) {
          console.log("Ignored low-confidence Whisper segment", {
            avgNoSpeech: Number(avgNoSpeech.toFixed(2)),
            avgLogProb: Number(avgLogProb.toFixed(2)),
            maxCompression: Number(maxCompression.toFixed(2)),
          });
          return;
        }
      }

      const normalizedText = text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").replace(/\s+/g, " ").trim();
      const knownHallucinations = new Set([
        "thanks for watching",
        "please subscribe",
        "subscribe to my channel",
      ]);
      if (knownHallucinations.has(normalizedText)) return;
      const delta = removeOverlap(allTranscript, text);
      allTranscript = `${allTranscript} ${text}`.trim().slice(-12000);
      if (delta) {
        send(client, { type: "transcript", text: delta, isFinal: true });
        utterance.push(delta);
        scheduleDetection();
      }
    } catch (e) {
      send(client, { type: "error", message: `Groq transcription failed: ${e instanceof Error ? e.message : "Unknown error"}` });
    }
  }
  async function drain() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length) await transcribe(queue.shift()!);
    } finally {
      processing = false;
      if (queue.length) void drain();
      else if (stopping) {
        stopping = false;
        active = false;
        clearDetectTimer();
        const finalQ = extractQuestion(utterance.join(" "));
        utterance = [];
        if (finalQ && normalize(finalQ) !== normalize(lastQuestion)) {
          lastQuestion = finalQ;
          void answerQuestion(client, finalQ, ctx);
        }
        send(client, { type: "stopped" });
      }
    }
  }

  client.on("message", (raw, isBinary) => {
    if (isBinary) {
      if (active) { queue.push(Buffer.from(raw as Buffer)); void drain(); }
      return;
    }
    let msg: { type?: string; resume?: string; jobDescription?: string; mode?: string; text?: string };
    try { msg = JSON.parse(raw.toString()) as typeof msg; } catch { return; }

    if (msg.type === "start") {
      if (!groq) { send(client, { type: "error", message: "GROQ_API_KEY is missing. Add it to .env and restart the backend." }); return; }
      clearDetectTimer();
      active = true; stopping = false; queue = []; allTranscript = ""; utterance = []; lastQuestion = ""; lastQuestionAt = 0;
      ctx = { resume: msg.resume, jobDescription: msg.jobDescription, mode: msg.mode || "concise", history: [] };
      send(client, { type: "ready" });
    } else if (msg.type === "stop") {
      stopping = true;
      clearDetectTimer();
      if (!processing && !queue.length) void drain();
    } else if (msg.type === "manual-question" && msg.text?.trim()) {
      ctx = { resume: msg.resume, jobDescription: msg.jobDescription, mode: msg.mode || "concise", history: ctx.history || [] };
      void answerQuestion(client, msg.text.trim(), ctx);
    }
  });
  client.on("close", () => { active = false; clearDetectTimer(); queue = []; });
  client.on("error", () => { active = false; clearDetectTimer(); queue = []; });
});
server.listen(PORT, () => console.log(`Interview Copilot backend listening on http://localhost:${PORT}`));
