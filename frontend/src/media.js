import { getToken } from "./api.js";

// لازم تطابق حدود المرفقات في backend/main.py
export const MAX_FILES = 5;
export const MAX_FILE_MB = 10;
export const ACCEPT = "image/*,application/pdf,audio/*,.txt,.md,.csv,.json,.xml,.html,.css,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.h,.cs,.go,.rs,.php,.rb,.sql,.yaml,.yml,.log,.ini,.sh";

const TEXT_EXT = /\.(txt|md|csv|json|xml|html|css|jsx?|tsx?|py|java|c|cpp|h|cs|go|rs|php|rb|sql|ya?ml|log|ini|sh)$/i;
const IMAGE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);
const AUDIO_OK = new Set(["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac", "audio/aac", "audio/aiff"]);

export function kindOf(mime, name) {
  if (IMAGE.has(mime)) return "image";
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/") || TEXT_EXT.test(name)) return "text";
  return null;
}

export const fmtSize = (b) => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} ك.ب` : `${(b / 1024 / 1024).toFixed(1)} م.ب`);

const toBase64 = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(",")[1] || "");
  r.onerror = () => reject(new Error("تعذّر قراءة الملف"));
  r.readAsDataURL(blob);
});

// تحويل أي صوت يقدر المتصفح يشغّله إلى WAV أحادي 16kHz (صيغة يقبلها النموذج)
export async function toWav(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const rate = 16000;
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * rate), rate);
    const src = off.createBufferSource();
    src.buffer = decoded; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    const buf = new ArrayBuffer(44 + pcm.length * 2), v = new DataView(buf);
    const str = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
    str(0, "RIFF"); v.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, pcm.length * 2, true);
    pcm.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
    return { blob: new Blob([buf], { type: "audio/wav" }), seconds: decoded.duration };
  } finally { ctx.close(); }
}

// يجهّز ملف للإرسال: بيتحقق من النوع والحجم ويحوّل الصوت غير المدعوم إلى WAV
export async function prepareFile(file) {
  let blob = file, name = file.name || "ملف", mime = file.type || "";
  if (!mime && TEXT_EXT.test(name)) mime = "text/plain";
  const kind = kindOf(mime, name);
  if (!kind) throw new Error(`نوع الملف «${name}» مش مدعوم`);
  if (kind === "audio" && !AUDIO_OK.has(mime)) {
    ({ blob } = await toWav(file)); mime = "audio/wav"; name = name.replace(/\.[^.]+$/, "") + ".wav";
  }
  if (blob.size > MAX_FILE_MB * 1024 * 1024) throw new Error(`الملف «${name}» أكبر من ${MAX_FILE_MB} ميجا`);
  return { key: crypto.randomUUID(), name, mime, kind, size: blob.size, url: URL.createObjectURL(blob), data: await toBase64(blob) };
}

// تسجيل صوتي من الميكروفون
export async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  return {
    stop: () => new Promise((resolve) => {
      rec.onstop = async () => { stream.getTracks().forEach((t) => t.stop()); resolve(new Blob(chunks, { type: rec.mimeType })); };
      rec.stop();
    }),
    cancel: () => { rec.onstop = null; rec.stop(); stream.getTracks().forEach((t) => t.stop()); },
  };
}

export async function recordingToAttachment(blob) {
  const { blob: wav, seconds } = await toWav(blob);
  const stamp = new Date().toLocaleTimeString("ar-EG", { hour: "2-digit", minute: "2-digit" });
  return { key: crypto.randomUUID(), name: `رسالة صوتية ${stamp}.wav`, mime: "audio/wav", kind: "audio", size: wav.size,
    url: URL.createObjectURL(wav), data: await toBase64(wav), seconds };
}

// المرفقات المحفوظة: بنجيبها بالتوكن ونعرضها كـ blob
const cache = new Map();
export async function attachmentUrl(id) {
  if (!cache.has(id)) {
    cache.set(id, fetch(`/api/attachments/${id}`, { headers: { Authorization: `Bearer ${getToken()}` } })
      .then((r) => { if (!r.ok) throw new Error(); return r.blob(); })
      .then((b) => URL.createObjectURL(b))
      .catch((e) => { cache.delete(id); throw e; }));
  }
  return cache.get(id);
}

// قراءة الردود بصوت: الصوت بيتولّد على السيرفر (نموذج Gemini للكلام) علشان العربي يتقري صح على أي جهاز.
// لو السيرفر فشل وفي صوت عربي متسطّب في المتصفح، بنستخدمه كبديل.
export const canSpeak = () => true;
let current = null; // { audio, url, ctrl, onEnd }
const voiceCache = new Map(); // نفس الرد ما يتولّدش مرتين

const arabicVoice = () => ("speechSynthesis" in window ? speechSynthesis.getVoices().find((v) => v.lang.startsWith("ar")) : null);

function browserSpeak(text, onEnd) {
  const voice = arabicVoice();
  if (!voice) return false;
  const u = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, " ").replace(/[*_#>`|~]+/g, " "));
  u.voice = voice; u.lang = voice.lang;
  u.onend = u.onerror = () => onEnd?.();
  speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking() {
  if (current) {
    current.ctrl.abort();
    current.audio?.pause();
    const done = current.onEnd; current = null; done?.();
  }
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// onState: "loading" ثم "playing" ثم null في الآخر. onError بيستقبل رسالة لو الصوت فشل.
export async function speak(text, { onState, onError } = {}) {
  stopSpeaking();
  const ctrl = new AbortController();
  const me = { ctrl, onEnd: () => onState?.(null) };
  current = me;
  onState?.("loading");
  try {
    let blob = voiceCache.get(text);
    if (!blob) {
      const r = await fetch("/api/tts", {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.detail === "daily_voice_limit" ? "خلصت قراءات الصوت المسموحة النهارده" : d.detail || "تعذّر تشغيل الصوت");
      }
      blob = await r.blob();
      voiceCache.set(text, blob);
    }
    if (current !== me) return; // اتلغى أو بدأ صوت تاني
    const audio = new Audio(URL.createObjectURL(blob));
    me.audio = audio;
    audio.onended = audio.onerror = () => { if (current === me) { current = null; onState?.(null); } };
    await audio.play();
    onState?.("playing");
  } catch (e) {
    if (e.name === "AbortError" || current !== me) return;
    current = null;
    if (browserSpeak(text, () => onState?.(null))) { onState?.("playing"); return; }
    onState?.(null);
    onError?.(e.message || "تعذّر تشغيل الصوت");
  }
}
