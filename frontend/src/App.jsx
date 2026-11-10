import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import {
  ACCEPT, MAX_FILES, attachmentUrl, canSpeak, fmtSize, kindOf, prepareFile,
  recordingToAttachment, speak, startRecording, stopSpeaking,
} from "./media.js";
import { sendToStudio, takeForChat } from "./handoff.js";

const TIER_LABEL = { fast: "سريع", balanced: "متوازن", strong: "قوي" };
const SIDE_KEY = "tagseed_side_open";
const VOICE_KEY = "tagseed_voice_replies";
const MAX_RECORD_SEC = 300;
const isNarrow = () => window.matchMedia("(max-width: 700px)").matches;
const readFlag = (k, dflt) => { try { const v = localStorage.getItem(k); return v === null ? dflt : v === "1"; } catch { return dflt; } };
const saveFlag = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch {} };

const initialSideOpen = () => (isNarrow() ? false : readFlag(SIDE_KEY, true));
const ICON = { pdf: "PDF", text: "TXT", audio: "♪", image: "IMG" };
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// مرفق واحد داخل الرسالة: صورة مصغّرة، مشغّل صوت، أو بطاقة ملف
function Attachment({ a, onEdit }) {
  const [url, setUrl] = useState(a.url || null);
  useEffect(() => { if (!url && a.id) attachmentUrl(a.id).then(setUrl).catch(() => {}); }, [a.id]);
  const kind = kindOf(a.mime, a.name);
  if (kind === "image") {
    return (
      <div className="att-img-wrap">
        {url
          ? <a className="att-img" href={url} target="_blank" rel="noreferrer"><img src={url} alt={a.name} /></a>
          : <div className="att-img loading" aria-label={a.name} />}
        {url && (
          <div className="att-actions">
            <button type="button" className="mini-btn" onClick={() => onEdit(url, a.name)}>
              تعديل في المحرر
            </button>
            <a className="mini-btn" href={url} download={a.name}>تحميل</a>
          </div>
        )}
      </div>
    );
  }
  if (kind === "audio") return <audio className="att-audio" controls src={url || undefined} aria-label={a.name} />;
  return (
    <a className="att-file" href={url || undefined} download={a.name}>
      <span className="att-ico" aria-hidden="true">{ICON[kind] || "FILE"}</span>
      <span className="att-meta"><span className="att-name">{a.name}</span><span className="att-size">{fmtSize(a.size)}</span></span>
    </a>
  );
}

export default function Chat({ ws, title, categories, me, refreshMe }) {
  const [sideOpen, setSideOpen] = useState(initialSideOpen);
  const [convs, setConvs] = useState([]);
  const [cid, setCid] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [rec, setRec] = useState(null); // { ctrl, start }
  const [recSec, setRecSec] = useState(0);
  const [voiceReplies, setVoiceReplies] = useState(() => readFlag(VOICE_KEY, false));
  const [speaking, setSpeaking] = useState(null); // { i, state: "loading" | "playing" }
  const endRef = useRef(null);
  const fileRef = useRef(null);
  const msgsRef = useRef(msgs);
  useEffect(() => { msgsRef.current = msgs; }, [msgs]);

  const loadConvs = () => api(`/conversations?workspace=${ws}`).then(setConvs).catch(() => {});
  useEffect(() => { setCid(null); setMsgs([]); loadConvs(); }, [ws]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => () => { stopSpeaking(); }, []);
  // راجع من المحرر بصورة متعدّلة: نرجع لنفس المحادثة والصورة تتحط كمرفق جاهز للإرسال
  useEffect(() => {
    const back = takeForChat(window.location.hash);
    if (!back) return;
    if (back.cid) open(back.cid);
    setPending((p) => [...p, back.attachment]);
  }, []);
  const editInStudio = (url, name) => sendToStudio({ url, name, returnTo: window.location.hash, cid });
  useEffect(() => {
    if (!rec) return undefined;
    const t = setInterval(() => {
      const s = (Date.now() - rec.start) / 1000;
      setRecSec(s);
      if (s >= MAX_RECORD_SEC) finishRecording();
    }, 250);
    return () => clearInterval(t);
  }, [rec]);

  const toggleSide = () => setSideOpen((o) => { if (!isNarrow()) saveFlag(SIDE_KEY, !o); return !o; });
  const closeOnNarrow = () => { if (isNarrow()) setSideOpen(false); };

  const open = async (id) => { closeOnNarrow(); stopSpeaking(); setCid(id); setError(""); setMsgs(await api(`/conversations/${id}`)); };
  const fresh = () => { closeOnNarrow(); stopSpeaking(); setCid(null); setMsgs([]); setError(""); };

  const addFiles = async (files) => {
    setError("");
    const list = [...files];
    if (pending.length + list.length > MAX_FILES) { setError(`أقصى عدد مرفقات في الرسالة ${MAX_FILES}`); return; }
    for (const f of list) {
      try { const a = await prepareFile(f); setPending((p) => [...p, a]); } catch (e) { setError(e.message); }
    }
  };
  const removePending = (key) => setPending((p) => p.filter((a) => a.key !== key));

  const play = (i, content) => speak(content, {
    onState: (state) => setSpeaking((s) => (state ? { i, state } : s?.i === i ? null : s)),
    onError: setError,
  });
  const say = (i, content) => {
    if (speaking?.i === i) { stopSpeaking(); setSpeaking(null); return; }
    play(i, content);
  };

  const send = async (extra = []) => {
    const message = text.trim();
    const atts = [...pending, ...extra];
    if ((!message && !atts.length) || busy) return;
    setText(""); setPending([]); setBusy(true); setError(""); stopSpeaking();
    setMsgs((m) => [...m, { role: "user", content: message, attachments: atts }]);
    try {
      const d = await api("/chat", { method: "POST", body: JSON.stringify({
        message, conversation_id: cid, workspace: ws,
        attachments: atts.map(({ name, mime, data }) => ({ name, mime, data })),
      }) });
      setCid(d.conversation_id);
      const i = msgsRef.current.length;
      setMsgs((m) => [...m, { role: "assistant", content: d.reply, tier: d.tier, attachments: d.reply_attachments }]);
      // اتكلمت بصوت؟ الرد يتقري بصوت تلقائيًا، حتى لو قراءة الردود مقفولة
      if (voiceReplies || extra.some((a) => a.kind === "audio")) play(i, d.reply);
      loadConvs(); refreshMe();
    } catch (e) {
      // نرجّع الرسالة والمرفقات علشان المستخدم يقدر يعيد الإرسال
      setMsgs((m) => m.slice(0, -1)); setText(message); setPending(atts.filter((a) => !extra.includes(a)));
      if (e.message !== "daily_limit") setError(e.message);
    }
    setBusy(false);
  };

  const beginRecording = async () => {
    setError(""); stopSpeaking();
    try { setRecSec(0); setRec({ ctrl: await startRecording(), start: Date.now() }); }
    catch { setError("مش قادرين نوصل للميكروفون. اسمح للموقع باستخدامه من إعدادات المتصفح."); }
  };
  const finishRecording = async () => {
    if (!rec) return;
    const { ctrl } = rec; setRec(null);
    try {
      const a = await recordingToAttachment(await ctrl.stop());
      if (a.seconds < 0.5) { setError("التسجيل قصير جدًا"); return; }
      send([a]);
    } catch { setError("تعذّر تجهيز التسجيل الصوتي، جرّب تاني"); }
  };
  const cancelRecording = () => { rec?.ctrl.cancel(); setRec(null); };

  const toggleVoice = () => { const v = !voiceReplies; setVoiceReplies(v); saveFlag(VOICE_KEY, v); if (!v) { stopSpeaking(); setSpeaking(null); } };

  const onDrop = (e) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); };
  const onPaste = (e) => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); addFiles(files); } };

  return (
    <div className={sideOpen ? "app" : "app side-closed"}>
      <aside className="side" id="chat-side" aria-hidden={!sideOpen}>
        <div className="brand"><img src="/logo.png" alt="" /><span>Tagseed</span></div>
        <button className="new" onClick={fresh}>+ محادثة جديدة</button>
        <div className="side-scroll">
          <h2 className="side-h">الأقسام</h2>
          <nav aria-label="الأقسام">
            {Object.entries(categories).map(([id, name]) => (
              <a key={id} href={`#/chat/${id}`} className={id === ws ? "item on" : "item"}
                aria-current={id === ws ? "page" : undefined} onClick={closeOnNarrow}>{name}</a>
            ))}
            <a className="item" href="#/">كل المساحات</a>
          </nav>
          <h2 className="side-h">المحادثات</h2>
          <nav aria-label="المحادثات">
            {convs.length === 0 && <p className="side-empty">لسه مفيش محادثات هنا.</p>}
            {convs.map((c) => (
              <button key={c.id} className={c.id === cid ? "item on" : "item"} onClick={() => open(c.id)}>{c.title}</button>
            ))}
          </nav>
        </div>
        <div className="side-foot">
          {me.requests_left !== null && <div className="trial">طلبات اليوم المتبقية: {me.requests_left} من {me.daily_limit}</div>}
          <a className="item side-account" href="#/account">
            <span className="avatar sm" aria-hidden="true">{(me.display_name || me.email).trim().charAt(0).toUpperCase()}</span>
            <span>حسابي والإعدادات</span>
          </a>
        </div>
      </aside>
      {sideOpen && <div className="side-backdrop" onClick={toggleSide} aria-hidden="true" />}
      <main className={dragging ? "main dragging" : "main"}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
        onDrop={onDrop}>
        <header className="chat-title">
          <button type="button" className="menu-btn" onClick={toggleSide} aria-controls="chat-side"
            aria-expanded={sideOpen} aria-label={sideOpen ? "إخفاء القائمة" : "إظهار القائمة"}>
            <span /><span /><span />
          </button>
          <span className="chat-title-text">{title}</span>
          {canSpeak() && (
            <button type="button" className={voiceReplies ? "voice-toggle on" : "voice-toggle"} onClick={toggleVoice} aria-pressed={voiceReplies}>
              {voiceReplies ? "قراءة الردود: شغّالة" : "قراءة الردود بالصوت"}
            </button>
          )}
        </header>
        <div className="feed">
          {msgs.length === 0 && (
            <div className="empty"><img src="/logo.png" alt="" /><h1>اسأل أي حاجة</h1>
              <p>اكتب، أو ارفق صورة أو ملف، أو اضغط على الميكروفون واتكلم.</p></div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.attachments?.length > 0 && (
                <div className="atts">{m.attachments.map((a) => <Attachment key={a.id || a.key} a={a} onEdit={editInStudio} />)}</div>
              )}
              {m.content && <div className="bubble">{m.content}</div>}
              {m.role === "assistant" && (
                <div className="msg-tools">
                  {m.tier && <span className="tag">نموذج {TIER_LABEL[m.tier]}</span>}
                  {canSpeak() && (
                    <button type="button" className="mini-btn" onClick={() => say(i, m.content)} aria-pressed={speaking?.i === i}>
                      {speaking?.i !== i ? "استمع" : speaking.state === "loading" ? "جاري تجهيز الصوت…" : "إيقاف"}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {busy && <div className="msg assistant"><div className="bubble dots">...</div></div>}
          {error && <div className="err" role="alert">{error}</div>}
          <div ref={endRef} />
        </div>
        {dragging && <div className="drop-hint" aria-hidden="true">أفلت الملفات هنا لإرفاقها</div>}
        <div className="composer-wrap">
          {pending.length > 0 && (
            <div className="pending" aria-label="المرفقات قبل الإرسال">
              {pending.map((a) => (
                <div key={a.key} className="chip">
                  {a.kind === "image" ? <img src={a.url} alt="" /> : <span className="att-ico" aria-hidden="true">{ICON[a.kind]}</span>}
                  <span className="chip-name">{a.name}</span>
                  <button type="button" onClick={() => removePending(a.key)} aria-label={`إزالة ${a.name}`}>×</button>
                </div>
              ))}
            </div>
          )}
          {rec ? (
            <div className="composer recording" role="status">
              <span className="rec-dot" aria-hidden="true" />
              <span className="rec-time">جاري التسجيل {clock(recSec)}</span>
              <span className="rec-limit">الحد {clock(MAX_RECORD_SEC)}</span>
              <button type="button" className="ghost-btn" onClick={cancelRecording}>إلغاء</button>
              <button type="button" onClick={finishRecording}>إرسال الصوت</button>
            </div>
          ) : (
            <div className="composer">
              <button type="button" className="icon-btn" onClick={() => fileRef.current?.click()} disabled={busy}
                aria-label="إرفاق ملف أو صورة" title="إرفاق ملف أو صورة">
                <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M16.5 6.5l-7.8 7.8a2 2 0 102.8 2.8l7.8-7.8a4 4 0 10-5.7-5.7l-8 8a6 6 0 108.5 8.5l6.4-6.4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              </button>
              <input ref={fileRef} type="file" multiple hidden accept={ACCEPT}
                onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
              <textarea rows={1} value={text} placeholder="اكتب رسالتك..." aria-label="رسالتك"
                onChange={(e) => setText(e.target.value)} onPaste={onPaste}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              {!text.trim() && !pending.length ? (
                <button type="button" className="icon-btn mic" onClick={beginRecording} disabled={busy}
                  aria-label="تسجيل رسالة صوتية" title="تسجيل رسالة صوتية">
                  <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M5 11a7 7 0 0014 0M12 18v3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                </button>
              ) : (
                <button type="button" onClick={() => send()} disabled={busy}>إرسال</button>
              )}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
