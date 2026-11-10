import { useEffect, useRef, useState } from "react";
import { Canvas, FabricImage, Textbox, Rect, Circle, PencilBrush, filters } from "fabric";
import { api } from "./api.js";
import { sendToChat, takeForStudio } from "./handoff.js";
import { prepareFile } from "./media.js";

const SIZE = 640;
const NAVY = "#28356E";

const kindName = (o) => o.name || ({ textbox: "نص", path: "رسم", rect: "مستطيل", circle: "دائرة", image: "صورة" }[o.type] || "عنصر");

export default function Studio() {
  const el = useRef(null);
  const cv = useRef(null);
  const hist = useRef({ stack: [], idx: -1, lock: false });
  const [tool, setTool] = useState("select");
  const [adj, setAdj] = useState({ b: 0, c: 0, s: 0 });
  const [, tick] = useState(0);
  const [imagesLeft, setImagesLeft] = useState(null);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState("");
  const [from, setFrom] = useState(null); // جاي من الشات: { returnTo, cid }
  const [sending, setSending] = useState(false);
  const refresh = () => tick((n) => n + 1);

  const snapshot = () => {
    const h = hist.current;
    if (h.lock || !cv.current) return;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(JSON.stringify(cv.current.toObject(["name"])));
    h.idx = h.stack.length - 1;
  };
  const restore = async (i) => {
    const h = hist.current;
    if (i < 0 || i >= h.stack.length) return;
    h.lock = true;
    h.idx = i;
    await cv.current.loadFromJSON(JSON.parse(h.stack[i]));
    cv.current.requestRenderAll();
    h.lock = false;
    refresh();
  };

  useEffect(() => {
    const c = new Canvas(el.current, { width: SIZE, height: SIZE, backgroundColor: "#F8F0EB", preserveObjectStacking: true });
    cv.current = c;
    snapshot();
    const onChange = () => { snapshot(); refresh(); };
    ["object:added", "object:removed", "object:modified"].forEach((e) => c.on(e, onChange));
    ["selection:created", "selection:updated", "selection:cleared"].forEach((e) => c.on(e, refresh));
    // صورة جاية من الشات: تملا اللوحة وتبقى جاهزة للتعديل
    const item = takeForStudio();
    if (item) {
      setFrom({ returnTo: item.returnTo, cid: item.cid });
      FabricImage.fromURL(item.url).then((img) => {
        if (cv.current !== c) return;
        img.scale(Math.min(SIZE / img.width, SIZE / img.height));
        img.set({ name: "الصورة من الشات" });
        c.add(img); c.centerObject(img); c.setActiveObject(img); c.requestRenderAll();
      });
    }
    return () => { c.dispose(); };
  }, []);

  // ترجع الصورة بعد التعديل لنفس المحادثة كمرفق جاهز للإرسال
  const backToChat = async () => {
    const c = cv.current;
    setSending(true);
    c.discardActiveObject(); c.requestRenderAll();
    const blob = await (await fetch(c.toDataURL({ format: "png", multiplier: 2 }))).blob();
    const att = await prepareFile(new File([blob], `tagseed-edit-${Date.now()}.png`, { type: "image/png" }));
    sendToChat(from.returnTo, from.cid, att);
  };

  useEffect(() => { api("/me").then((m) => setImagesLeft(m.images_left)).catch(() => {}); }, []);

  useEffect(() => {
    const c = cv.current;
    if (!c) return;
    c.isDrawingMode = tool === "brush";
    if (tool === "brush") {
      const b = new PencilBrush(c);
      b.color = NAVY;
      b.width = 6;
      c.freeDrawingBrush = b;
    }
  }, [tool]);

  const add = (o) => { const c = cv.current; c.add(o); c.centerObject(o); c.setActiveObject(o); c.requestRenderAll(); setTool("select"); };
  const addImage = async (file) => {
    if (!file) return;
    const img = await FabricImage.fromURL(URL.createObjectURL(file));
    img.scaleToWidth(Math.min(img.width, SIZE * 0.8));
    img.set({ name: file.name.slice(0, 24) });
    add(img);
  };
  const addDataUrl = async (url, name) => {
    const img = await FabricImage.fromURL(url);
    img.scaleToWidth(Math.min(img.width, SIZE * 0.8));
    img.set({ name });
    add(img);
  };
  const runAi = async (payload) => {
    setAiBusy(true); setAiError("");
    try {
      const d = await api("/images", { method: "POST", body: JSON.stringify(payload) });
      await addDataUrl(d.image, "صورة AI");
      setImagesLeft(d.images_left);
      setAiPrompt("");
    } catch (e) {
      setAiError(e.message === "daily_image_limit" ? "وصلت لحد الصور اليومي، يتجدد بكرة." : e.message);
    }
    setAiBusy(false);
  };
  const aiGenerate = () => { if (aiPrompt.trim()) runAi({ prompt: aiPrompt.trim() }); };
  const aiEdit = () => {
    const o = cv.current.getActiveObject();
    if (!(o instanceof FabricImage)) { setAiError("حدد طبقة صورة الأول من الطبقات أو من اللوحة."); return; }
    if (aiPrompt.trim()) runAi({ prompt: aiPrompt.trim(), source_image: o.toDataURL({ format: "png" }) });
  };
  const addText = () => add(new Textbox("اكتب هنا", { fontFamily: "Cairo", fontSize: 40, fill: NAVY, width: 280, textAlign: "right", direction: "rtl", name: "نص" }));
  const addRect = () => add(new Rect({ width: 160, height: 120, fill: "#BB9593", rx: 12, ry: 12, name: "مستطيل" }));
  const addCircle = () => add(new Circle({ radius: 70, fill: "#666B96", name: "دائرة" }));
  const removeActive = () => { const c = cv.current; c.getActiveObjects().forEach((o) => c.remove(o)); c.discardActiveObject(); c.requestRenderAll(); };

  const applyAdj = (next) => {
    setAdj(next);
    const c = cv.current;
    const o = c.getActiveObject();
    const t = o instanceof FabricImage ? o : c.getObjects().find((x) => x instanceof FabricImage);
    if (!t) return;
    t.filters = [
      new filters.Brightness({ brightness: next.b / 100 }),
      new filters.Contrast({ contrast: next.c / 100 }),
      new filters.Saturation({ saturation: next.s / 100 }),
    ];
    t.applyFilters();
    c.requestRenderAll();
  };

  const download = (href, name) => { const a = document.createElement("a"); a.href = href; a.download = name; a.click(); };
  const exportPng = () => { const c = cv.current; c.discardActiveObject(); c.requestRenderAll(); download(c.toDataURL({ format: "png", multiplier: 2 }), "tagseed-design.png"); };
  const saveProject = () => {
    const blob = new Blob([JSON.stringify(cv.current.toObject(["name"]))], { type: "application/json" });
    download(URL.createObjectURL(blob), "tagseed-project.json");
  };
  const openProject = async (file) => {
    if (!file) return;
    hist.current.lock = true;
    await cv.current.loadFromJSON(JSON.parse(await file.text()));
    hist.current.lock = false;
    snapshot();
    cv.current.requestRenderAll();
    refresh();
  };

  const c = cv.current;
  const layers = c ? c.getObjects().slice().reverse() : [];
  const active = c ? c.getActiveObject() : null;
  const pick = (o) => { c.setActiveObject(o); c.requestRenderAll(); refresh(); };
  const toggle = (o) => { o.set({ visible: !o.visible }); c.discardActiveObject(); c.requestRenderAll(); snapshot(); refresh(); };
  const move = (o, up) => { up ? c.bringObjectForward(o) : c.sendObjectBackwards(o); c.requestRenderAll(); snapshot(); refresh(); };

  const T = ({ id, label }) => (
    <button type="button" className={tool === id ? "tool on" : "tool"} onClick={() => setTool(id)}>{label}</button>
  );

  return (
    <div className="studio">
      <header className="s-top">
        <a className="s-back" href={from?.returnTo || "#/"}>{from ? "رجوع للشات" : "رجوع"}</a>
        <strong>استوديو الصور</strong>
        <div className="s-actions">
          {from && (
            <button type="button" className="tool strong" onClick={backToChat} disabled={sending}>
              {sending ? "جاري التجهيز..." : "إرسال للشات"}
            </button>
          )}
          <button type="button" className="tool" onClick={() => restore(hist.current.idx - 1)}>تراجع</button>
          <button type="button" className="tool" onClick={() => restore(hist.current.idx + 1)}>إعادة</button>
          <label className="tool">فتح مشروع<input hidden type="file" accept="application/json" onChange={(e) => openProject(e.target.files[0])} /></label>
          <button type="button" className="tool" onClick={saveProject}>حفظ المشروع</button>
          <button type="button" className="tool strong" onClick={exportPng}>تصدير PNG</button>
        </div>
      </header>
      <div className="s-body">
        <div className="s-tools">
          <T id="select" label="تحديد" />
          <T id="brush" label="فرشاة" />
          <button type="button" className="tool" onClick={addText}>+ نص</button>
          <button type="button" className="tool" onClick={addRect}>+ مستطيل</button>
          <button type="button" className="tool" onClick={addCircle}>+ دائرة</button>
          <label className="tool">+ صورة<input hidden type="file" accept="image/*" onChange={(e) => { addImage(e.target.files[0]); e.target.value = ""; }} /></label>
          <button type="button" className="tool" onClick={removeActive} disabled={!active}>حذف</button>
        </div>
        <div className="s-stage"><canvas ref={el} /></div>
        <aside className="s-panel">
          <h3>الطبقات</h3>
          <div className="layers">
            {layers.length === 0 && <p className="hint">ارفع صورة أو أضف عنصرًا للبدء.</p>}
            {layers.map((o, i) => (
              <div key={i} className={o === active ? "layer on" : "layer"}>
                <button type="button" className="l-name" onClick={() => pick(o)}>{kindName(o)}</button>
                <button type="button" aria-label="إظهار أو إخفاء" onClick={() => toggle(o)}>{o.visible ? "إخفاء" : "إظهار"}</button>
                <button type="button" aria-label="للأمام" onClick={() => move(o, true)}>↑</button>
                <button type="button" aria-label="للخلف" onClick={() => move(o, false)}>↓</button>
              </div>
            ))}
          </div>
          <h3>الذكاء الاصطناعي</h3>
          <div className="ai-box">
            <label htmlFor="aiPrompt">وصف الصورة أو التعديل</label>
            <textarea id="aiPrompt" rows={3} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="مثال: فستان سهرة أخضر زمردي من الستان" />
            <button type="button" className="tool strong" disabled={aiBusy || !aiPrompt.trim()} onClick={aiGenerate}>
              {aiBusy ? "جاري التنفيذ..." : "ولّد صورة جديدة"}
            </button>
            <button type="button" className="tool" disabled={aiBusy || !aiPrompt.trim()} onClick={aiEdit}>عدّل الصورة المحددة</button>
            {imagesLeft !== null && <p className="hint">صور اليوم المتبقية: {imagesLeft}</p>}
            {aiError && <p className="err" role="alert">{aiError}</p>}
          </div>
          <h3>تعديلات الصورة</h3>
          {[["b", "السطوع"], ["c", "التباين"], ["s", "التشبّع"]].map(([k, l]) => (
            <label key={k} className="slider">{l}
              <input type="range" min="-100" max="100" value={adj[k]} onChange={(e) => applyAdj({ ...adj, [k]: +e.target.value })} onPointerUp={snapshot} />
            </label>
          ))}
        </aside>
      </div>
    </div>
  );
}
