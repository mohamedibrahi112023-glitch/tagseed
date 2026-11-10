import { useEffect, useState } from "react";
import { api, setToken } from "./api.js";

export default function Workspaces({ me, onLogout }) {
  const [list, setList] = useState([]);
  const [live, setLive] = useState(true);
  useEffect(() => {
    api("/workspaces").then(setList).catch(() => {});
    api("/health").then((h) => setLive(h.configured)).catch(() => {});
  }, []);
  const left = me.requests_left;

  return (
    <div className="page">
      <header className="page-top">
        <div className="brand"><img src="/logo.png" alt="" /><span>Tagseed</span></div>
        <div className="top-right">
          <a className="acc-link" href="#/account" aria-label="حسابي والإعدادات">
            <span className="avatar sm" aria-hidden="true">{(me.display_name || me.email).trim().charAt(0).toUpperCase()}</span>
            <span>{me.display_name || me.email}</span>
          </a>
          <button className="btn ghost" onClick={onLogout}>خروج</button>
        </div>
      </header>
      <main className="page-main">
        <h1>{me.display_name ? `أهلًا ${me.display_name}، اختار مساحة العمل` : "اختار مساحة العمل"}</h1>
        {!live && (
          <div className="banner warn" role="alert">
            <div><strong>الخدمة غير مهيّأة بعد</strong>
              <p>ضيف مفتاح API واسم النموذج في ملف backend/.env ثم أعد تشغيل السيرفر. طلباتك مش بتتخصم من الحد اليومي لحد ما الخدمة تشتغل.</p></div>
          </div>
        )}
        {left !== null && (
          <div className="banner">
            <div><strong>الموقع مجاني. طلباتك المتبقية اليوم: {left} من {me.daily_limit}</strong>
              <p>الحد اليومي بيتجدد كل يوم، وبيتحسب عند كل طلب في أي مساحة عمل.</p></div>
          </div>
        )}
        <div className="ws-grid">
          {list.map((w) => (
            <div className="ws-card" key={w.id}>
              <h3>{w.title}</h3>
              <p>{w.desc}</p>
              <div className="ws-actions">
                <a className="btn primary" href={`#/chat/${w.id}`}>محادثة</a>
                {w.editor && <a className="btn ghost" href="#/studio">المحرر</a>}
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
