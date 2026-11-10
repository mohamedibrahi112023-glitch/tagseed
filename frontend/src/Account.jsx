import { useState } from "react";
import { api, setToken } from "./api.js";
import { COUNTRIES, ROLES } from "./profile.js";

const SIDE_KEY = "tagseed_side_open";
const readSide = () => { try { return localStorage.getItem(SIDE_KEY) !== "0"; } catch { return true; } };
const joined = (ts) => (ts ? new Date(ts * 1000).toLocaleDateString("ar-EG", { year: "numeric", month: "long", day: "numeric" }) : "");

// رسالة نجاح أو خطأ تحت كل قسم
const Note = ({ msg }) => msg && <p className={msg.ok ? "note ok" : "note err"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>;

function Usage({ label, left, total }) {
  if (left === null) return <div className="usage"><span>{label}</span><strong>بدون حد</strong></div>;
  const used = total - left;
  return (
    <div className="usage">
      <span>{label}</span>
      <strong>{left} متبقية من {total}</strong>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={used}>
        <div style={{ width: `${(used / total) * 100}%` }} />
      </div>
    </div>
  );
}

export default function Account({ me, categories, refreshMe, onLogout }) {
  const [name, setName] = useState(me.display_name);
  const [homeWs, setHomeWs] = useState(me.home_ws);
  const [role, setRole] = useState(me.role || "");
  const [country, setCountry] = useState(me.country || "");
  const [sideOpen, setSideOpen] = useState(readSide);
  const [profileMsg, setProfileMsg] = useState(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwMsg, setPwMsg] = useState(null);
  const [dataMsg, setDataMsg] = useState(null);
  const [delPw, setDelPw] = useState("");
  const [busy, setBusy] = useState("");

  const run = async (key, fn, setMsg) => {
    setBusy(key); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy("");
  };

  const saveProfile = (e) => {
    e.preventDefault();
    run("profile", async () => {
      await api("/me", { method: "PATCH", body: JSON.stringify({ display_name: name, home_ws: homeWs, role, country }) });
      try { localStorage.setItem(SIDE_KEY, sideOpen ? "1" : "0"); } catch {}
      await refreshMe();
      return "اتحفظت الإعدادات.";
    }, setProfileMsg);
  };

  const changePassword = (e) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) { setPwMsg({ ok: false, text: "كلمتا المرور الجديدتان مش متطابقتين." }); return; }
    run("password", async () => {
      const d = await api("/me/password", { method: "POST", body: JSON.stringify({ current: pw.current, new: pw.next }) });
      setToken(d.token);
      setPw({ current: "", next: "", confirm: "" });
      return "اتغيرت كلمة المرور، وخرجنا الحساب من أي جهاز تاني.";
    }, setPwMsg);
  };

  const clearChats = () => {
    if (!window.confirm("هتتمسح كل محادثاتك في كل المساحات، ومش هينفع ترجعها. متأكد؟")) return;
    run("clear", async () => {
      const d = await api("/me/conversations", { method: "DELETE" });
      await refreshMe();
      return `اتمسحت ${d.deleted} محادثة.`;
    }, setDataMsg);
  };

  const deleteAccount = (e) => {
    e.preventDefault();
    if (!window.confirm("هيتمسح حسابك وكل محادثاتك نهائيًا. متأكد؟")) return;
    run("delete", async () => {
      await api("/me/delete", { method: "POST", body: JSON.stringify({ password: delPw }) });
      onLogout();
      return "";
    }, setDataMsg);
  };

  const initial = (me.display_name || me.email).trim().charAt(0).toUpperCase();

  return (
    <div className="page">
      <header className="page-top">
        <div className="brand"><img src="/logo.png" alt="" /><span>Tagseed</span></div>
        <div className="top-right"><a className="btn ghost" href="#/">رجوع لمساحات العمل</a></div>
      </header>
      <main className="page-main account">
        <div className="acc-head">
          <div className="avatar" aria-hidden="true">{initial}</div>
          <div>
            <h1>{me.display_name || "حسابي"}</h1>
            <p>{[me.email, ROLES[me.role], me.country, `عضو من ${joined(me.created)}`].filter(Boolean).join(" · ")}</p>
          </div>
        </div>

        <section className="acc-card" aria-labelledby="h-usage">
          <h2 id="h-usage">استخدام اليوم</h2>
          <div className="usage-row">
            <Usage label="طلبات المحادثة" left={me.requests_left} total={me.daily_limit} />
            <Usage label="الصور" left={me.images_left} total={me.daily_images} />
            <div className="usage"><span>المحادثات المحفوظة</span><strong>{me.conversations}</strong></div>
          </div>
          <p className="hint">الحد اليومي بيتجدد كل يوم.</p>
        </section>

        <form className="acc-card" onSubmit={saveProfile} aria-labelledby="h-profile">
          <h2 id="h-profile">الملف الشخصي والتفضيلات</h2>
          <label>الاسم
            <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="اسمك اللي هيظهر في الموقع" />
          </label>
          <label>البريد الإلكتروني
            <input value={me.email} disabled />
          </label>
          <div className="acc-two">
            <label>أنا
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="">غير محدد</option>
                {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label>الدولة
              <select value={country} onChange={(e) => setCountry(e.target.value)}>
                <option value="">غير محددة</option>
                {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <label>مساحة البداية بعد تسجيل الدخول
            <select value={homeWs} onChange={(e) => setHomeWs(e.target.value)}>
              <option value="">صفحة كل المساحات</option>
              {Object.entries(categories).map(([id, title]) => <option key={id} value={id}>{title}</option>)}
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={sideOpen} onChange={(e) => setSideOpen(e.target.checked)} />
            القائمة الجانبية في الشات مفتوحة افتراضيًا
          </label>
          <Note msg={profileMsg} />
          <button className="btn primary" disabled={busy === "profile"}>حفظ</button>
        </form>

        <form className="acc-card" onSubmit={changePassword} aria-labelledby="h-security">
          <h2 id="h-security">الأمان</h2>
          <label>كلمة المرور الحالية
            <input type="password" required autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          </label>
          <label>كلمة المرور الجديدة
            <input type="password" required minLength={8} autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          </label>
          <label>تأكيد كلمة المرور الجديدة
            <input type="password" required minLength={8} autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
          </label>
          <Note msg={pwMsg} />
          <button className="btn primary" disabled={busy === "password"}>تغيير كلمة المرور</button>
        </form>

        <section className="acc-card danger" aria-labelledby="h-data">
          <h2 id="h-data">البيانات والحساب</h2>
          <div className="acc-row">
            <div><strong>مسح كل المحادثات</strong><p className="hint">بيمسح محادثاتك في كل المساحات، والحساب يفضل زي ما هو.</p></div>
            <button type="button" className="btn ghost" onClick={clearChats} disabled={busy === "clear"}>مسح المحادثات</button>
          </div>
          <form className="acc-row" onSubmit={deleteAccount}>
            <div><strong>حذف الحساب نهائيًا</strong><p className="hint">اكتب كلمة المرور للتأكيد.</p>
              <input type="password" required autoComplete="current-password" aria-label="كلمة المرور لتأكيد الحذف" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
            </div>
            <button className="btn danger-btn" disabled={busy === "delete"}>حذف الحساب</button>
          </form>
          <Note msg={dataMsg} />
        </section>

        <button type="button" className="btn ghost logout" onClick={onLogout}>تسجيل الخروج</button>
      </main>
    </div>
  );
}
