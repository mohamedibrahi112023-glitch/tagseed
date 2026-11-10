import asyncio, base64, os, re, sqlite3, time, uuid
from urllib.parse import quote
import bcrypt, httpx, jwt
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from router import pick_tier
from workspaces import WORKSPACES
DB_PATH = os.getenv("DB_PATH", "tagseed_v2.db")
os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "1500"))
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://openrouter.ai/api/v1").rstrip("/")
LLM_KEY = os.getenv("LLM_API_KEY", "") or OPENROUTER_KEY
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_IMAGE_MODELS = os.getenv("GEMINI_IMAGE_MODELS", "")  # أسماء مفصولة بفاصلة، تُجرَّب بالترتيب
DAILY_IMAGES = int(os.getenv("DAILY_IMAGES", "5"))  # 0 = بدون حد
# مزوّدين توليد الصور بالترتيب: gemini (محتاج تفعيل الدفع) ثم pollinations (مجاني من غير مفتاح)
IMAGE_PROVIDERS = {p.strip() for p in os.getenv("IMAGE_PROVIDERS", "gemini,pollinations").split(",") if p.strip()}
POLLINATIONS_TOKEN = os.getenv("POLLINATIONS_TOKEN", "")  # اختياري: بيشيل العلامة المائية
# نماذج تحويل النص لكلام، مفصولة بفاصلة وتُجرَّب بالترتيب
TTS_MODELS = os.getenv("TTS_MODELS", "gemini-3.8-flash-lite-tts,gemini-3.1-flash-tts-preview")
TTS_VOICE = os.getenv("TTS_VOICE", "Kore")
DAILY_TTS = int(os.getenv("DAILY_TTS", "60"))  # 0 = بدون حد
MODELS = {t: os.getenv(f"MODEL_{t.upper()}", "") for t in ("fast", "balanced", "strong")}
JWT_SECRET = os.getenv("JWT_SECRET", "dev-secret-change-me")
DAILY_REQUESTS = int(os.getenv("DAILY_REQUESTS", "20"))  # 0 = بدون حد
SIGNUPS_PER_IP_DAY = int(os.getenv("SIGNUPS_PER_IP_DAY", "5"))
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# على السيرفر الحقيقي (ENV=production) ممنوع نشتغل بمفتاح الجلسات الافتراضي: أي حد كان هيقدر يزوّر جلسة
if os.getenv("ENV") == "production" and JWT_SECRET == "dev-secret-change-me":
    raise RuntimeError("JWT_SECRET لازم يتغيّر قبل النشر")
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:5173").split(",") if o.strip()]

app = FastAPI(title="Tagseed API")
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS,
                   allow_methods=["*"], allow_headers=["*"])
bearer = HTTPBearer(auto_error=False)


def db():
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


with db() as c:
    c.executescript("""
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL, trials_used INTEGER NOT NULL DEFAULT 0, subscribed INTEGER NOT NULL DEFAULT 0, created REAL);
    CREATE TABLE IF NOT EXISTS signups(ip TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, workspace TEXT NOT NULL,
        title TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL,
        role TEXT, content TEXT, model TEXT, created REAL);
    CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, message_id INTEGER NOT NULL, name TEXT NOT NULL,
        mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL);
    CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
    """)
    cols = {r[1] for r in c.execute("PRAGMA table_info(users)")}
    if "usage_day" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN usage_day TEXT")
    if "usage_count" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0")
    if "img_day" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN img_day TEXT")
    if "img_count" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN img_count INTEGER NOT NULL DEFAULT 0")
    if "tts_day" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN tts_day TEXT")
    if "tts_count" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN tts_count INTEGER NOT NULL DEFAULT 0")
    if "display_name" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
    if "home_ws" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN home_ws TEXT NOT NULL DEFAULT ''")
    if "token_ver" not in cols:  # بيزيد مع تغيير كلمة المرور فيلغي الجلسات القديمة
        c.execute("ALTER TABLE users ADD COLUMN token_ver INTEGER NOT NULL DEFAULT 0")
    if "role" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT ''")
    if "country" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN country TEXT NOT NULL DEFAULT ''")
    if "terms_at" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN terms_at REAL")


# ---------- auth ----------
class AuthIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(min_length=1, max_length=200)


# لازم تطابق ROLES في frontend/src/profile.js
ROLES = {"student", "designer", "developer", "creator", "researcher", "business", "other"}


class RegisterIn(AuthIn):
    display_name: str = Field(max_length=60)
    role: str = ""
    country: str = Field(default="", max_length=60)
    accept_terms: bool = False


def clean_profile(role: str | None, country: str | None):
    if role and role not in ROLES:
        raise HTTPException(400, "اختار نوع مستخدم من القائمة")
    return (role or "").strip(), (country or "").strip()


def make_token(uid: int, ver: int = 0) -> str:
    return jwt.encode({"sub": str(uid), "ver": ver, "exp": int(time.time()) + 30 * 86400}, JWT_SECRET, algorithm="HS256")


def current_user(cred: HTTPAuthorizationCredentials | None = Depends(bearer)):
    if not cred:
        raise HTTPException(401, "سجّل الدخول أولًا")
    try:
        claims = jwt.decode(cred.credentials, JWT_SECRET, algorithms=["HS256"])
        uid, ver = int(claims["sub"]), int(claims.get("ver", 0))
    except (jwt.PyJWTError, ValueError, KeyError):
        raise HTTPException(401, "انتهت الجلسة، سجّل الدخول مرة أخرى")
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise HTTPException(401, "الحساب غير موجود")
    if ver != u["token_ver"]:
        raise HTTPException(401, "انتهت الجلسة، سجّل الدخول مرة أخرى")
    return u


def today() -> str:
    return time.strftime("%Y-%m-%d")


QUOTA = {"chat": ("usage_day", "usage_count", lambda: DAILY_REQUESTS, "daily_limit"),
         "img": ("img_day", "img_count", lambda: DAILY_IMAGES, "daily_image_limit"),
         "tts": ("tts_day", "tts_count", lambda: DAILY_TTS, "daily_voice_limit")}


def left(u, kind="chat"):
    day_col, cnt_col, limit, _ = QUOTA[kind]
    if limit() == 0:
        return None
    used = u[cnt_col] if u[day_col] == today() else 0
    return max(0, limit() - used)


@app.post("/api/auth/register")
def register(body: RegisterIn, request: Request):
    email = body.email.strip().lower()
    name = body.display_name.strip()
    if len(name) < 2:
        raise HTTPException(400, "اكتب اسمك (حرفين على الأقل)")
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "اكتب بريدًا إلكترونيًا صحيحًا")
    if len(body.password) < 8:
        raise HTTPException(400, "كلمة المرور لازم تكون 8 حروف على الأقل")
    if not body.accept_terms:
        raise HTTPException(400, "لازم توافق على شروط الاستخدام")
    role, country = clean_profile(body.role, body.country)
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    with db() as c:
        n = c.execute("SELECT COUNT(*) FROM signups WHERE ip=? AND created>?", (ip, now - 86400)).fetchone()[0]
        if n >= SIGNUPS_PER_IP_DAY:
            raise HTTPException(429, "عدد كبير من التسجيلات من نفس الجهاز، جرّب لاحقًا")
        if c.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            raise HTTPException(409, "البريد ده مسجّل بالفعل")
        h = bcrypt.hashpw(body.password.encode(), bcrypt.gensalt()).decode()
        uid = c.execute("INSERT INTO users(email,password_hash,created,display_name,role,country,terms_at) VALUES(?,?,?,?,?,?,?)",
                        (email, h, now, name, role, country, now)).lastrowid
        c.execute("INSERT INTO signups VALUES(?,?)", (ip, now))
    return {"token": make_token(uid, 0)}


@app.post("/api/auth/login")
def login(body: AuthIn):
    with db() as c:
        u = c.execute("SELECT * FROM users WHERE email=?", (body.email.strip().lower(),)).fetchone()
    if not u or not bcrypt.checkpw(body.password.encode(), u["password_hash"].encode()):
        raise HTTPException(400, "البريد أو كلمة المرور غير صحيحة")
    return {"token": make_token(u["id"], u["token_ver"])}


@app.get("/api/me")
def me(u=Depends(current_user)):
    with db() as c:
        convs = c.execute("SELECT COUNT(*) FROM conversations WHERE user_id=?", (u["id"],)).fetchone()[0]
    return {"email": u["email"], "display_name": u["display_name"], "home_ws": u["home_ws"],
            "role": u["role"], "country": u["country"],
            "created": u["created"], "conversations": convs,
            "requests_left": left(u), "daily_limit": DAILY_REQUESTS,
            "images_left": left(u, "img"), "daily_images": DAILY_IMAGES}


# ---------- الحساب والإعدادات ----------
class ProfileIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=60)
    home_ws: str | None = None
    role: str | None = None
    country: str | None = Field(default=None, max_length=60)


class PasswordIn(BaseModel):
    current: str = Field(min_length=1, max_length=200)
    new: str = Field(min_length=1, max_length=200)


class ConfirmIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)


def check_password(u, password: str):
    if not bcrypt.checkpw(password.encode(), u["password_hash"].encode()):
        raise HTTPException(400, "كلمة المرور الحالية غير صحيحة")


@app.patch("/api/me")
def update_profile(body: ProfileIn, u=Depends(current_user)):
    fields = {}
    if body.display_name is not None:
        fields["display_name"] = body.display_name.strip()
    if body.home_ws is not None:
        if body.home_ws and body.home_ws not in WORKSPACES:
            raise HTTPException(400, "مساحة عمل غير معروفة")
        fields["home_ws"] = body.home_ws
    if body.role is not None:
        fields["role"] = clean_profile(body.role, None)[0]
    if body.country is not None:
        fields["country"] = body.country.strip()
    if fields:
        with db() as c:
            c.execute(f"UPDATE users SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?", (*fields.values(), u["id"]))
    return {"ok": True}


@app.post("/api/me/password")
def change_password(body: PasswordIn, u=Depends(current_user)):
    check_password(u, body.current)
    if len(body.new) < 8:
        raise HTTPException(400, "كلمة المرور الجديدة لازم تكون 8 حروف على الأقل")
    h = bcrypt.hashpw(body.new.encode(), bcrypt.gensalt()).decode()
    ver = u["token_ver"] + 1
    with db() as c:
        c.execute("UPDATE users SET password_hash=?, token_ver=? WHERE id=?", (h, ver, u["id"]))
    return {"token": make_token(u["id"], ver)}  # الجهاز الحالي يكمّل، والباقي يخرج


@app.delete("/api/me/conversations")
def clear_conversations(u=Depends(current_user)):
    with db() as c:
        delete_attachments_of(c, "conversation_id IN (SELECT id FROM conversations WHERE user_id=?)", (u["id"],))
        c.execute("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)", (u["id"],))
        n = c.execute("DELETE FROM conversations WHERE user_id=?", (u["id"],)).rowcount
    return {"deleted": n}


@app.post("/api/me/delete")
def delete_account(body: ConfirmIn, u=Depends(current_user)):
    check_password(u, body.password)
    with db() as c:
        delete_attachments_of(c, "conversation_id IN (SELECT id FROM conversations WHERE user_id=?)", (u["id"],))
        c.execute("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)", (u["id"],))
        c.execute("DELETE FROM conversations WHERE user_id=?", (u["id"],))
        c.execute("DELETE FROM users WHERE id=?", (u["id"],))
    return {"ok": True}


@app.get("/api/workspaces")
def workspaces(u=Depends(current_user)):
    return [{"id": k, "title": v["title"], "desc": v["desc"], "editor": v["editor"]} for k, v in WORKSPACES.items()]


# ---------- حد الاستخدام اليومي ----------
def take_quota(uid: int, kind: str = "chat") -> bool:
    """يخصم وحدة من حد اليوم بشكل ذري. يرفع 429 لو خلص الحد."""
    day_col, cnt_col, limit, code = QUOTA[kind]
    if limit() == 0:
        return False
    d = today()
    with db() as c:
        cur = c.execute(
            f"UPDATE users SET {cnt_col} = CASE WHEN {day_col}=? THEN {cnt_col}+1 ELSE 1 END, {day_col}=? "
            f"WHERE id=? AND (COALESCE({day_col},'')<>? OR {cnt_col}<?)", (d, d, uid, d, limit()))
        if cur.rowcount == 0:
            raise HTTPException(429, code)
        return True


def refund_quota(uid: int, kind: str = "chat"):
    day_col, cnt_col, _, _ = QUOTA[kind]
    with db() as c:
        c.execute(f"UPDATE users SET {cnt_col}={cnt_col}-1 WHERE id=? AND {day_col}=? AND {cnt_col}>0", (uid, today()))


# ---------- المرفقات ----------
MAX_FILES, MAX_FILE_MB, MAX_TOTAL_MB = 5, 10, 15
TEXT_EXT = {".txt", ".md", ".csv", ".json", ".xml", ".html", ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".java",
            ".c", ".cpp", ".h", ".cs", ".go", ".rs", ".php", ".rb", ".sql", ".yaml", ".yml", ".log", ".ini", ".sh"}
IMAGE_MIMES = {"image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"}
AUDIO_MIMES = {"audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp3", "audio/ogg", "audio/flac", "audio/aac", "audio/aiff"}


class AttachmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    mime: str = Field(default="", max_length=100)
    data: str = Field(max_length=int(MAX_FILE_MB * 1024 * 1024 * 1.4))  # base64


def att_kind(mime: str, name: str) -> str | None:
    """نوع المرفق كما يفهمه النموذج: image / pdf / audio / text، أو None لو مش مدعوم."""
    ext = os.path.splitext(name.lower())[1]
    if mime in IMAGE_MIMES:
        return "image"
    if mime == "application/pdf" or ext == ".pdf":
        return "pdf"
    if mime in AUDIO_MIMES:
        return "audio"
    if mime.startswith("text/") or mime in {"application/json", "application/xml", "application/javascript"} or ext in TEXT_EXT:
        return "text"
    return None


def decode_attachments(items: list[AttachmentIn]) -> list[dict]:
    if len(items) > MAX_FILES:
        raise HTTPException(400, f"أقصى عدد مرفقات في الرسالة {MAX_FILES}")
    out, total = [], 0
    for a in items:
        kind = att_kind(a.mime, a.name)
        if not kind:
            raise HTTPException(400, f"نوع الملف «{a.name}» مش مدعوم. المدعوم: صور، PDF، صوت، وملفات نصية وأكواد")
        try:
            raw = base64.b64decode(a.data, validate=True)
        except ValueError:
            raise HTTPException(400, f"الملف «{a.name}» تالف")
        if len(raw) > MAX_FILE_MB * 1024 * 1024:
            raise HTTPException(400, f"الملف «{a.name}» أكبر من {MAX_FILE_MB} ميجا")
        total += len(raw)
        mime = a.mime or ("application/pdf" if kind == "pdf" else "text/plain")
        out.append({"name": a.name, "mime": mime, "kind": kind, "data": raw})
    if total > MAX_TOTAL_MB * 1024 * 1024:
        raise HTTPException(400, f"مجموع المرفقات أكبر من {MAX_TOTAL_MB} ميجا")
    return out


def as_text(att: dict) -> str:
    return f"[ملف مرفق: {att['name']}]\n{att['data'].decode('utf-8', errors='replace')[:100_000]}"


def delete_attachments_of(c, where: str, args: tuple):
    c.execute(f"DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE {where})", args)


# ---------- صور من الشات ----------
# النموذج بيكتب [[IMAGE: وصف إنجليزي]] لما المستخدم يطلب صورة (workspaces.py: IMAGE_TOOL)
IMAGE_TAG_RE = re.compile(r"\[\[\s*IMAGE\s*:\s*(.+?)\]\]", re.S | re.I)
# طلب صريح لصورة (شبكة أمان لو النموذج نسي العلامة)
IMAGE_ASK_RE = re.compile(
    r"(اعمل|اعملي|اعملى|ولّد|ولد|ولدي|ارسم|ارسمي|ارسملي|صمم|صمّم|صممي|صمملي|طلع|طلعلي|هات|هاتلي|وريني|ورّيني|عايز اشوف|عايزة اشوف)"
    r"[^.؟?!\n]{0,40}(صورة|صوره|صور|رسمة|رسمه|تصميم|لوجو|شعار)"
    r"|\b(generate|create|draw|make|show)\b[^.?!\n]{0,40}\b(image|picture|photo|drawing|logo)\b", re.I)


DETAIL_SUFFIX = (". Highly detailed, sharp focus, crisp fine details and textures, professional photography, "
                 "high resolution, no text, no watermark.")


def strip_image_tags(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", IMAGE_TAG_RE.sub("", text)).strip()


async def make_image(prompt: str) -> tuple[str, bytes] | None:
    """يولّد صورة من وصف إنجليزي بنفس ترتيب المزوّدين في /api/images. يرجّع (mime, bytes) أو None."""
    full = f"{prompt[:1500]}{DETAIL_SUFFIX}"
    models = [m.strip() for m in GEMINI_IMAGE_MODELS.split(",") if m.strip()] if GEMINI_KEY else []
    url = await gemini_image(models, [{"text": full}]) if "gemini" in IMAGE_PROVIDERS and models else None
    if not url and "pollinations" in IMAGE_PROVIDERS:
        url = await pollinations_image(full)
    if not url:
        return None
    head, data = url.split(",", 1)
    return head[5:].split(";")[0], base64.b64decode(data)


# ---------- chat ----------
class ChatIn(BaseModel):
    message: str = Field(default="", max_length=8000)
    conversation_id: str | None = None
    workspace: str = "general"
    attachments: list[AttachmentIn] = []


def provider_for(model: str):
    """يحدد المزوّد حسب اسم النموذج والمفاتيح المتاحة. None يعني الخدمة غير مهيّأة."""
    if not model:
        return None
    if GEMINI_KEY and model.startswith("gemini"):
        return "gemini"
    if ANTHROPIC_KEY and model.startswith("claude-"):
        return "anthropic"
    if LLM_KEY:
        return "openai"
    return None


BUSY_MSG = "النموذج عليه ضغط دلوقتي (حد الطلبات في الدقيقة). استنى دقيقة وجرّب تاني"


async def gemini_generate(model: str, body: dict, raise_busy: bool = False, timeout: float = 180):
    """استدعاء Gemini generateContent. يرجّع JSON أو None لو فشل (مع طباعة السبب في السيرفر).
    raise_busy: لو المزوّد رجّع 429 (حد الدقيقة) نبلّغ المستخدم بدل رسالة خطأ عامة."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        r = await client.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            headers={"x-goog-api-key": GEMINI_KEY, "content-type": "application/json"}, json=body)
    if r.status_code != 200:
        print(f"[gemini error] {model} -> {r.status_code}: {r.text[:500]}")
        if raise_busy and r.status_code in (429, 503):
            raise HTTPException(503, BUSY_MSG)
        return None
    return r.json()


def b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def gemini_parts(m: dict) -> list[dict]:
    atts = m.get("atts") or []
    parts = [{"text": m["content"]}] if m["content"] else []
    if not parts and any(a["kind"] == "audio" for a in atts):
        parts.append({"text": "(رسالة صوتية من المستخدم: استمع لها ورد عليها)"})
    for a in atts:
        parts.append({"text": as_text(a)} if a["kind"] == "text" else {"inlineData": {"mimeType": a["mime"], "data": b64(a["data"])}})
    return parts or [{"text": "."}]


def anthropic_content(m: dict):
    atts = m.get("atts") or []
    if not atts:
        return m["content"]
    blocks = []
    for a in atts:
        if a["kind"] == "image" and a["mime"] in {"image/png", "image/jpeg", "image/webp", "image/gif"}:
            blocks.append({"type": "image", "source": {"type": "base64", "media_type": a["mime"], "data": b64(a["data"])}})
        elif a["kind"] == "pdf":
            blocks.append({"type": "document", "source": {"type": "base64", "media_type": "application/pdf", "data": b64(a["data"])}})
        elif a["kind"] == "text":
            blocks.append({"type": "text", "text": as_text(a)})
        else:
            raise HTTPException(400, f"النموذج الحالي مش بيدعم الملف «{a['name']}»")
    if m["content"]:
        blocks.append({"type": "text", "text": m["content"]})
    return blocks


def openai_content(m: dict):
    atts = m.get("atts") or []
    if not atts:
        return m["content"]
    blocks = [{"type": "text", "text": m["content"]}] if m["content"] else []
    for a in atts:
        if a["kind"] == "image":
            blocks.append({"type": "image_url", "image_url": {"url": f"data:{a['mime']};base64,{b64(a['data'])}"}})
        elif a["kind"] == "text":
            blocks.append({"type": "text", "text": as_text(a)})
        else:
            raise HTTPException(400, f"النموذج الحالي مش بيدعم الملف «{a['name']}»")
    return blocks


async def call_llm(provider: str, model: str, system: str, history: list[dict]) -> str:
    while history and history[0]["role"] != "user":
        history = history[1:]
    if provider == "gemini":
        data = await gemini_generate(model, {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user" if m["role"] == "user" else "model", "parts": gemini_parts(m)} for m in history],
            "generationConfig": {"maxOutputTokens": MAX_TOKENS}}, raise_busy=True)
        if data is None:
            raise HTTPException(502, "مزوّد النموذج رجّع خطأ. راجع المفتاح واسم النموذج في ملف .env")
        parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts)
    else:
        async with httpx.AsyncClient(timeout=120) as client:
            if provider == "anthropic":
                r = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                    json={"model": model, "max_tokens": MAX_TOKENS, "system": system,
                          "messages": [{"role": m["role"], "content": anthropic_content(m)} for m in history]})
            else:
                r = await client.post(
                    f"{LLM_BASE_URL}/chat/completions",
                    headers={"Authorization": f"Bearer {LLM_KEY}"},
                    json={"model": model, "max_tokens": MAX_TOKENS,
                          "messages": [{"role": "system", "content": system}] +
                                      [{"role": m["role"], "content": openai_content(m)} for m in history]})
        if r.status_code != 200:
            print(f"[provider error] {provider} {model} -> {r.status_code}: {r.text[:500]}")
            raise HTTPException(502, f"مزوّد النموذج رجّع خطأ ({r.status_code}). راجع المفتاح واسم النموذج في ملف .env")
        data = r.json()
        if provider == "anthropic":
            text = "".join(b.get("text", "") for b in data.get("content", []) if b.get("type") == "text")
        else:
            text = data["choices"][0]["message"]["content"]
    if not text.strip():
        raise HTTPException(502, "النموذج رجّع رد فاضي، جرّب تاني")
    return text


@app.get("/api/health")
def health():
    tiers = {t: bool(provider_for(m)) for t, m in MODELS.items()}
    return {"configured": all(tiers.values()), "tiers": tiers,
            "images": bool(GEMINI_KEY and GEMINI_IMAGE_MODELS.strip()) or "pollinations" in IMAGE_PROVIDERS}


@app.post("/api/chat")
async def chat(body: ChatIn, u=Depends(current_user)):
    ws = WORKSPACES.get(body.workspace)
    if not ws:
        raise HTTPException(400, "مساحة عمل غير معروفة")
    uid = u["id"]
    cid = body.conversation_id
    text = body.message.strip()
    atts = decode_attachments(body.attachments)
    if not text and not atts:
        raise HTTPException(400, "اكتب رسالة أو ارفق ملف")
    tier = ws["tier"] or pick_tier(text)
    if atts and tier == "fast":  # الصور والملفات تحتاج نموذج أقوى من السريع
        tier = "balanced"
    model = MODELS[tier]
    provider = provider_for(model)
    if not provider:  # الخدمة مش مهيّأة: ما نخصمش من الحد ولا نرجّع رد وهمي
        raise HTTPException(503, f"الخدمة غير مهيّأة للمستوى ({tier}). ضيف مفتاح API واسم النموذج في ملف .env ثم أعد تشغيل السيرفر")
    with db() as c:
        if cid and not c.execute("SELECT 1 FROM conversations WHERE id=? AND user_id=? AND workspace=?",
                                 (cid, uid, body.workspace)).fetchone():
            raise HTTPException(404, "المحادثة غير موجودة")
    consumed = take_quota(uid)
    new_conv, msg_id, saved = False, None, []
    title = text[:40] or (atts[0]["name"][:40] if atts else "")
    if atts and not text and all(a["kind"] == "audio" for a in atts):
        title = "رسالة صوتية"
    try:
        with db() as c:
            if not cid:
                cid, new_conv = uuid.uuid4().hex, True
                c.execute("INSERT INTO conversations VALUES(?,?,?,?,?)", (cid, uid, body.workspace, title, time.time()))
            msg_id = c.execute("INSERT INTO messages(conversation_id,role,content,created) VALUES(?,?,?,?)",
                               (cid, "user", text, time.time())).lastrowid
            for a in atts:
                aid = uuid.uuid4().hex
                c.execute("INSERT INTO attachments VALUES(?,?,?,?,?,?)", (aid, msg_id, a["name"], a["mime"], len(a["data"]), a["data"]))
                saved.append({"id": aid, "name": a["name"], "mime": a["mime"], "size": len(a["data"])})
            rows = c.execute("SELECT id,role,content FROM messages WHERE conversation_id=? ORDER BY id", (cid,)).fetchall()[-20:]
            hist = [dict(role=r["role"], content=r["content"], id=r["id"]) for r in rows]
            # المرفقات بتتبعت مع آخر 10 رسائل بس علشان حجم الطلب
            recent = [m["id"] for m in hist[-10:]]
            for a in c.execute(f"SELECT message_id,name,mime,data FROM attachments WHERE message_id IN ({','.join('?' * len(recent))})", recent):
                m = next(x for x in hist if x["id"] == a["message_id"])
                if m["role"] == "user":  # الصور اللي ولّدناها بتفضل في النص كوصف (علامة IMAGE) مش كملف
                    m.setdefault("atts", []).append({"name": a["name"], "mime": a["mime"], "kind": att_kind(a["mime"], a["name"]), "data": a["data"]})
        try:
            reply = await call_llm(provider, model, ws["system"], hist)
        except HTTPException as e:
            # النموذج الأقوى عليه ضغط أو خلص حده اليومي: نكمّل بالنموذج السريع بدل ما نوقف المستخدم
            fast = MODELS["fast"]
            if e.detail != BUSY_MSG or tier == "fast" or not provider_for(fast):
                raise
            print(f"[fallback] {model} busy -> {fast}")
            tier, model, provider = "fast", fast, provider_for(fast)
            reply = await call_llm(provider, model, ws["system"], hist)
    except Exception:
        if consumed:
            refund_quota(uid)
        with db() as c:  # نشيل رسالة المستخدم اللي فشل ردها عشان ما تتكررش في السياق
            if msg_id:
                c.execute("DELETE FROM attachments WHERE message_id=?", (msg_id,))
                c.execute("DELETE FROM messages WHERE id=?", (msg_id,))
            if new_conv:
                c.execute("DELETE FROM conversations WHERE id=?", (cid,))
        raise
    # النموذج طلب صورة؟ نولّدها ونرفقها بالرد
    shown, image, note = strip_image_tags(reply), None, ""
    tag = IMAGE_TAG_RE.search(reply)
    img_prompt = tag.group(1).strip() if tag else None
    if not tag and not atts and IMAGE_ASK_RE.search(text):  # المستخدم طلب صورة صراحةً والنموذج نسي العلامة
        img_prompt = await enhance_prompt(text, edit=False)
        reply = f"{reply}\n[[IMAGE: {img_prompt}]]"
    if img_prompt:
        shown = shown or "اتفضل الصورة."
        try:
            img_consumed = take_quota(uid, "img")
        except HTTPException:
            note = "خلصت صور النهارده، ترجع بكرة."
        else:
            image = await make_image(img_prompt)
            if not image:
                if img_consumed:
                    refund_quota(uid, "img")
                note = "خدمة الصور عليها ضغط دلوقتي، ابعت نفس الطلب تاني بعد دقيقة."
    reply_atts = []
    with db() as c:
        rid = c.execute("INSERT INTO messages(conversation_id,role,content,model,created) VALUES(?,?,?,?,?)",
                        (cid, "assistant", reply, model, time.time())).lastrowid
        if image:
            mime, raw = image
            aid = uuid.uuid4().hex
            name = f"tagseed-{time.strftime('%Y%m%d-%H%M%S')}.{'png' if mime == 'image/png' else 'jpg'}"
            c.execute("INSERT INTO attachments VALUES(?,?,?,?,?,?)", (aid, rid, name, mime, len(raw), raw))
            reply_atts.append({"id": aid, "name": name, "mime": mime, "size": len(raw)})
        fresh = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if note:
        shown = f"{shown}\n\n{note}"
    return {"conversation_id": cid, "reply": shown, "tier": tier, "model": model, "requests_left": left(fresh),
            "attachments": saved, "reply_attachments": reply_atts, "images_left": left(fresh, "img")}


# ---------- تحويل الرد لصوت ----------
class TtsIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


def speech_text(text: str) -> str:
    """ننضّف الرد قبل قراءته: الكود والرموز ما بتتقراش."""
    t = re.sub(r"```[\s\S]*?```", " (في الرد كود، تقدر تشوفه مكتوب) ", text)
    t = re.sub(r"https?://\S+", " ", t)
    t = re.sub(r"[*_#>`|~]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()[:2500]


def pcm_to_wav(pcm: bytes, rate: int) -> bytes:
    import struct
    return (b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " +
            struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(pcm)) + pcm)


@app.post("/api/tts")
async def tts(body: TtsIn, u=Depends(current_user)):
    models = [m.strip() for m in TTS_MODELS.split(",") if m.strip()]
    if not GEMINI_KEY or not models:
        raise HTTPException(503, "تحويل الرد لصوت غير مهيّأ. ضيف GEMINI_API_KEY في ملف .env")
    text = speech_text(body.text)
    if not text:
        raise HTTPException(400, "مفيش نص يتقري")
    consumed = take_quota(u["id"], "tts")
    try:
        for model in models:
            try:  # نموذج بطيء؟ ننتقل للي بعده بدل ما المستخدم يستنى
                data = await gemini_generate(model, {
                    "contents": [{"role": "user", "parts": [{"text": text}]}],
                    "generationConfig": {"responseModalities": ["AUDIO"],
                                         "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": TTS_VOICE}}}}},
                    timeout=25)
            except httpx.TimeoutException:
                print(f"[tts timeout] {model}")
                continue
            parts = (((data or {}).get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
            inline = next((p.get("inlineData") for p in parts if p.get("inlineData")), None)
            if not inline:
                continue
            audio, mime = base64.b64decode(inline["data"]), inline.get("mimeType", "")
            if not mime.startswith("audio/wav"):  # PCM خام (audio/l16; rate=24000) → WAV
                m = re.search(r"rate=(\d+)", mime)
                audio = pcm_to_wav(audio, int(m.group(1)) if m else 24000)
            return Response(audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})
        raise HTTPException(502, "تعذّر تحويل الرد لصوت دلوقتي، جرّب تاني")
    except Exception:
        if consumed:
            refund_quota(u["id"], "tts")
        raise


# ---------- الصور (توليد وتعديل) ----------
DATA_URL_RE = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$")


class ImageIn(BaseModel):
    prompt: str = Field(min_length=1, max_length=2000)
    source_image: str | None = Field(default=None, max_length=12_000_000)  # data URL للتعديل


async def enhance_prompt(prompt: str, edit: bool) -> str:
    """يحوّل وصف المستخدم (بأي لغة) لوصف إنجليزي دقيق. لو فشل نستخدم الوصف زي ما هو."""
    model = MODELS["fast"]
    provider = provider_for(model)
    if not provider:
        return prompt
    kind = "an image EDIT instruction" if edit else "a photorealistic image generation prompt"
    system = (f"Rewrite the user's request as {kind} in English: one precise paragraph, keep every detail the user "
              "gave (item, color, material, style, setting), add nothing contradictory. Output only the prompt.")
    try:
        return (await call_llm(provider, model, system, [{"role": "user", "content": prompt}])).strip()[:1500]
    except HTTPException:
        return prompt


async def gemini_image(models: list[str], parts: list[dict]) -> str | None:
    """يجرّب نماذج صور Gemini بالترتيب. يرجّع data URL أو None (مثلًا لو الحساب على الخطة المجانية)."""
    for model in models:
        data = await gemini_generate(model, {"contents": [{"role": "user", "parts": parts}],
                                             "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]}})
        cand = ((data or {}).get("candidates") or [{}])[0]
        for p in (cand.get("content") or {}).get("parts") or []:
            inline = p.get("inlineData") or p.get("inline_data")
            if inline and inline.get("data"):
                return f"data:{inline.get('mimeType') or inline.get('mime_type') or 'image/png'};base64,{inline['data']}"
    return None


async def pollinations_image(prompt: str) -> str | None:
    """توليد مجاني من Pollinations (من غير مفتاح). مع POLLINATIONS_TOKEN (مجاني من موقعهم) العلامة المائية بتختفي."""
    url = f"https://image.pollinations.ai/prompt/{quote(prompt[:1000])}"
    params = {"width": 1024, "height": 1024, "seed": uuid.uuid4().int % 1_000_000, "nologo": "true", "model": "flux",
              "enhance": "true"}  # Pollinations بيوسّع الوصف بتفاصيل أكتر
    headers = {"Authorization": f"Bearer {POLLINATIONS_TOKEN}"} if POLLINATIONS_TOKEN else {}
    try:
        async with httpx.AsyncClient(timeout=90, follow_redirects=True) as client:
            r = await client.get(url, params=params, headers=headers)
            # من غير مفتاح: صورة كل 45 ثانية للسيرفر كله. لو الانتظار قصير نستنى ونعيد مرة واحدة
            wait = re.search(r"[Rr]etry after (\d+)\s*s", r.text) if r.status_code in (402, 429) else None
            if wait and int(wait.group(1)) <= 20:
                await asyncio.sleep(int(wait.group(1)) + 1)
                r = await client.get(url, params=params, headers=headers)
    except httpx.HTTPError as e:
        print(f"[pollinations error] {type(e).__name__}")
        return None
    mime = r.headers.get("content-type", "").split(";")[0]
    if r.status_code != 200 or not mime.startswith("image/") or len(r.content) < 1024:
        print(f"[pollinations error] {r.status_code} {mime} {r.text[:200] if not mime.startswith('image/') else ''}")
        return None
    return f"data:{mime};base64,{base64.b64encode(r.content).decode()}"


@app.post("/api/images")
async def images(body: ImageIn, u=Depends(current_user)):
    models = [m.strip() for m in GEMINI_IMAGE_MODELS.split(",") if m.strip()] if GEMINI_KEY else []
    use_free = "pollinations" in IMAGE_PROVIDERS
    if not models and not use_free:
        raise HTTPException(503, "توليد الصور غير مهيّأ. ضيف GEMINI_IMAGE_MODELS أو فعّل pollinations في IMAGE_PROVIDERS")
    src = None
    if body.source_image:
        m = DATA_URL_RE.match(body.source_image)
        if not m:
            raise HTTPException(400, "صيغة الصورة غير مدعومة (PNG أو JPEG أو WebP)")
        src = (m.group(1), m.group(2))
    uid = u["id"]
    consumed = take_quota(uid, "img")
    try:
        en = await enhance_prompt(body.prompt, edit=bool(src))
        if src:
            text = ("Edit this exact image. Keep the subject, pose, composition, lighting and background unchanged "
                    f"and apply only this modification realistically: {en}")
            parts = [{"text": text}, {"inlineData": {"mimeType": src[0], "data": src[1]}}]
        else:
            full = f"A single photorealistic photograph, natural light: {en}{DETAIL_SUFFIX}"
            parts = [{"text": full}]
        image = await gemini_image(models, parts) if "gemini" in IMAGE_PROVIDERS else None
        if not image and not src and use_free:  # الخطة المجانية لـ Gemini مفيهاش صور: نستخدم Pollinations
            image = await pollinations_image(full)
        if not image:
            if src:
                raise HTTPException(503, "تعديل صورة موجودة بالذكاء الاصطناعي محتاج تفعيل الدفع على حساب Google. "
                                         "توليد صورة جديدة شغال مجانًا")
            raise HTTPException(502, "تعذّر توليد الصورة دلوقتي. جرّب تاني بعد شوية أو بوصف مختلف")
        with db() as c:
            fresh = c.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        return {"image": image, "images_left": left(fresh, "img")}
    except Exception:
        if consumed:
            refund_quota(uid, "img")
        raise


@app.get("/api/conversations")
def conversations(workspace: str = "general", u=Depends(current_user)):
    with db() as c:
        return [dict(r) for r in c.execute(
            "SELECT id,title FROM conversations WHERE user_id=? AND workspace=? ORDER BY created DESC", (u["id"], workspace))]


@app.get("/api/conversations/{cid}")
def messages(cid: str, u=Depends(current_user)):
    with db() as c:
        if not c.execute("SELECT 1 FROM conversations WHERE id=? AND user_id=?", (cid, u["id"])).fetchone():
            raise HTTPException(404, "المحادثة غير موجودة")
        msgs = [dict(r) for r in c.execute(
            "SELECT id,role,content,model FROM messages WHERE conversation_id=? ORDER BY id", (cid,))]
        for m in msgs:
            if m["role"] == "assistant":
                m["content"] = strip_image_tags(m["content"])
        by_id = {m["id"]: m for m in msgs}
        for a in c.execute("SELECT a.id,a.message_id,a.name,a.mime,a.size FROM attachments a JOIN messages m ON m.id=a.message_id "
                           "WHERE m.conversation_id=? ORDER BY a.rowid", (cid,)):
            by_id[a["message_id"]].setdefault("attachments", []).append(
                {"id": a["id"], "name": a["name"], "mime": a["mime"], "size": a["size"]})
        return msgs


@app.get("/api/attachments/{aid}")
def attachment(aid: str, u=Depends(current_user)):
    with db() as c:
        a = c.execute("SELECT a.name,a.mime,a.data FROM attachments a JOIN messages m ON m.id=a.message_id "
                      "JOIN conversations v ON v.id=m.conversation_id WHERE a.id=? AND v.user_id=?", (aid, u["id"])).fetchone()
    if not a:
        raise HTTPException(404, "الملف غير موجود")
    safe = att_kind(a["mime"], a["name"]) in {"image", "audio", "pdf"}
    return Response(a["data"], media_type=a["mime"] if safe else "text/plain; charset=utf-8",
                    headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(a['name'])}",
                             "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=3600"})


# ---------- الواجهة بعد البناء ----------
# في النشر الخادم بيقدّم الواجهة كمان (رابط واحد للموقع). محليًا Vite هو اللي بيقدّمها، والفولدر ده مش موجود.
# لازم يفضل آخر حاجة في الملف علشان مسارات /api تتطابق الأول.
FRONTEND_DIST = os.getenv("FRONTEND_DIST", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "frontend", "dist"))
if os.path.isdir(FRONTEND_DIST):
    app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="frontend")
