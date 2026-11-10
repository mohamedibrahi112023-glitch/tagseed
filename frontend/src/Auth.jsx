import { useState } from "react";
import { api, setToken } from "./api.js";
import { COUNTRIES, ROLES } from "./profile.js";

const FEATURES = [
  ["٧ مساحات عمل", "أزياء، ديكور، صور، برمجة، أبحاث، والمزيد"],
  ["اختيار تلقائي للنموذج", "كل طلب يروح للنموذج المناسب له"],
  ["مجاني كل يوم", "٢٠ طلبًا و٥ صور يوميًا لكل مستخدم"],
];

// قوة كلمة المرور: الشرط الأساسي 8 حروف، والباقي نصائح
const RULES = [
  ["len", "8 حروف على الأقل", (p) => p.length >= 8],
  ["mix", "حروف وأرقام", (p) => /\d/.test(p) && /[^\d\s]/.test(p)],
  ["case", "حرف كبير وصغير، أو حرف عربي", (p) => (/[a-z]/.test(p) && /[A-Z]/.test(p)) || /[؀-ۿ]/.test(p)],
  ["sym", "رمز مثل ! أو @", (p) => /[^\w\s؀-ۿ]/.test(p)],
];
const LEVELS = ["", "ضعيفة", "مقبولة", "جيدة", "قوية"];

function PasswordInput({ id, value, onChange, autoComplete, minLength }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-field">
      <input id={id} type={show ? "text" : "password"} required minLength={minLength} autoComplete={autoComplete}
        value={value} onChange={(e) => onChange(e.target.value)} />
      <button type="button" className="pw-toggle" onClick={() => setShow(!show)}
        aria-label={show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} aria-pressed={show}>{show ? "إخفاء" : "إظهار"}</button>
    </div>
  );
}

export default function Auth({ onDone }) {
  const [mode, setMode] = useState("login");
  const [f, setF] = useState({ name: "", email: "", password: "", confirm: "", role: "", country: "", terms: false });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setF((x) => ({ ...x, [k]: v }));
  const register = mode === "register";

  const passed = RULES.filter(([, , ok]) => ok(f.password)).length;
  const mismatch = f.confirm && f.confirm !== f.password;

  const switchMode = (m) => { setMode(m); setError(""); };

  const submit = async (e) => {
    e.preventDefault();
    if (register && f.password !== f.confirm) { setError("كلمتا المرور مش متطابقتين."); return; }
    setBusy(true); setError("");
    const body = register
      ? { display_name: f.name, email: f.email, password: f.password, role: f.role, country: f.country, accept_terms: f.terms }
      : { email: f.email, password: f.password };
    try {
      const d = await api(`/auth/${mode}`, { method: "POST", body: JSON.stringify(body) });
      setToken(d.token);
      window.location.hash = "#/";
      onDone();
    } catch (err) { setError(err.message); }
    setBusy(false);
  };

  return (
    <div className="auth-split">
      <aside className="auth-panel">
        <div className="auth-brand light"><img src="/logo.png" alt="" /><span>Tagseed</span></div>
        <h2>منصة ذكاء اصطناعي عربية واحدة لكل شغلك</h2>
        <ul>
          {FEATURES.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}
        </ul>
      </aside>

      <main className="auth-main">
        <form className="auth-form" onSubmit={submit} noValidate={false}>
          <div className="auth-brand mobile-only"><img src="/logo.png" alt="" /><span>Tagseed</span></div>
          <div className="auth-tabs" role="tablist" aria-label="نوع الصفحة">
            <button type="button" role="tab" aria-selected={!register} className={!register ? "on" : ""} onClick={() => switchMode("login")}>تسجيل الدخول</button>
            <button type="button" role="tab" aria-selected={register} className={register ? "on" : ""} onClick={() => switchMode("register")}>إنشاء حساب</button>
          </div>
          <h1>{register ? "أنشئ حسابك المجاني" : "أهلًا بعودتك"}</h1>
          <p className="auth-sub">{register ? "دقيقة واحدة وتبدأ تستخدم كل مساحات العمل." : "سجّل الدخول علشان تكمل محادثاتك."}</p>

          {register && (
            <label htmlFor="f-name"><span>الاسم الكامل <span className="req" aria-hidden="true">*</span></span>
              <input id="f-name" required minLength={2} maxLength={60} autoComplete="name" value={f.name}
                onChange={(e) => set("name")(e.target.value)} placeholder="مثال: سارة أحمد" />
            </label>
          )}

          <label htmlFor="f-email"><span>البريد الإلكتروني <span className="req" aria-hidden="true">*</span></span>
            <input id="f-email" type="email" required autoComplete="email" dir="ltr" value={f.email}
              onChange={(e) => set("email")(e.target.value)} placeholder="name@example.com" />
          </label>

          <label htmlFor="f-pw"><span>كلمة المرور <span className="req" aria-hidden="true">*</span></span>
            <PasswordInput id="f-pw" value={f.password} onChange={set("password")}
              autoComplete={register ? "new-password" : "current-password"} minLength={register ? 8 : 1} />
          </label>

          {register && (
            <>
              <div className="pw-meter" aria-live="polite">
                <div className="pw-bars" aria-hidden="true">
                  {[1, 2, 3, 4].map((i) => <span key={i} className={i <= passed ? `on l${passed}` : ""} />)}
                </div>
                <span className="pw-level">{f.password ? `قوة كلمة المرور: ${LEVELS[passed] || "ضعيفة جدًا"}` : "اختار كلمة مرور قوية"}</span>
                <ul className="pw-rules">
                  {RULES.map(([k, label, ok]) => <li key={k} className={ok(f.password) ? "ok" : ""}>{ok(f.password) ? "✓ " : "– "}{label}</li>)}
                </ul>
              </div>

              <label htmlFor="f-confirm"><span>تأكيد كلمة المرور <span className="req" aria-hidden="true">*</span></span>
                <PasswordInput id="f-confirm" value={f.confirm} onChange={set("confirm")} autoComplete="new-password" minLength={8} />
                {mismatch && <span className="field-err" role="alert">كلمتا المرور مش متطابقتين</span>}
              </label>

              <div className="auth-row">
                <label htmlFor="f-role">أنا
                  <select id="f-role" value={f.role} onChange={(e) => set("role")(e.target.value)}>
                    <option value="">اختياري</option>
                    {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label htmlFor="f-country">الدولة
                  <select id="f-country" value={f.country} onChange={(e) => set("country")(e.target.value)}>
                    <option value="">اختياري</option>
                    {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>

              <label className="terms">
                <input type="checkbox" required checked={f.terms} onChange={(e) => set("terms")(e.target.checked)} />
                <span>أوافق على شروط الاستخدام وسياسة الخصوصية <span className="req" aria-hidden="true">*</span></span>
              </label>
              <details className="terms-box">
                <summary>ملخص الشروط</summary>
                <ul>
                  <li>الخدمة مجانية بحد يومي للطلبات والصور.</li>
                  <li>ممنوع استخدام المنصة لمحتوى مسيء أو مخالف للقانون.</li>
                  <li>كلمة مرورك محفوظة مشفّرة، ومحادثاتك خاصة بحسابك.</li>
                  <li>تقدر تمسح محادثاتك أو حسابك في أي وقت من صفحة الإعدادات.</li>
                </ul>
              </details>
            </>
          )}

          {error && <p className="err" role="alert">{error}</p>}
          <button className="btn primary wide" disabled={busy || (register && (!f.terms || mismatch))}>
            {busy ? "لحظة..." : register ? "إنشاء الحساب" : "دخول"}
          </button>
          <p className="swap">
            {register ? "عندك حساب؟ " : "ليس لديك حساب؟ "}
            <button type="button" className="linkbtn" onClick={() => switchMode(register ? "login" : "register")}>
              {register ? "سجّل الدخول" : "أنشئ حسابًا مجانيًا"}
            </button>
          </p>
        </form>
      </main>
    </div>
  );
}
