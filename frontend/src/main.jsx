import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import Chat from "./App.jsx";
import Account from "./Account.jsx";
import Auth from "./Auth.jsx";
import Limit from "./Limit.jsx";
import Studio from "./Studio.jsx";
import Workspaces from "./Workspaces.jsx";
import { api, getToken, setToken } from "./api.js";
import "./styles.css";

const TITLES = {
  general: "TagSeed AI", fashion: "تصميم وتعديل الأزياء", decor: "الديكور الداخلي والأثاث",
  "image-studio": "استوديو الصور", "image-analysis": "تحليل الصور", code: "البرمجة وهندسة الأنظمة", research: "الأبحاث والكتابة",
};

function Root() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  const [me, setMe] = useState(null);
  const [authed, setAuthed] = useState(!!getToken());

  const loadMe = useCallback(async () => {
    if (!getToken()) { setAuthed(false); setMe(null); return null; }
    setAuthed(true);
    try { const m = await api("/me"); setMe(m); return m; } catch { setAuthed(!!getToken()); return null; }
  }, []);

  // بعد تسجيل الدخول: افتح مساحة البداية اللي المستخدم اختارها في الإعدادات
  const afterLogin = async () => {
    const m = await loadMe();
    if (m?.home_ws) window.location.hash = `#/chat/${m.home_ws}`;
  };

  useEffect(() => {
    const on = () => { setHash(window.location.hash || "#/"); if (!getToken()) setAuthed(false); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  useEffect(() => { loadMe(); }, [loadMe]);

  const logout = () => { setToken(null); setMe(null); setAuthed(false); window.location.hash = "#/login"; };

  if (!authed) return <Auth onDone={afterLogin} />;
  if (!me) return <div className="boot">جاري التحميل...</div>;
  if (hash === "#/limit") return <Limit />;
  if (hash === "#/account") return <Account me={me} categories={TITLES} refreshMe={loadMe} onLogout={logout} />;
  if (hash === "#/studio") return <Studio />;
  if (hash.startsWith("#/chat/")) {
    const ws = hash.slice(7);
    return <Chat key={ws} ws={ws} title={TITLES[ws] || ws} categories={TITLES} me={me} refreshMe={loadMe} />;
  }
  return <Workspaces me={me} onLogout={logout} />;
}
createRoot(document.getElementById("root")).render(<Root />);
