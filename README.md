# Tagseed

**منصة ذكاء اصطناعي عربية واحدة، بتختار النموذج الأنسب لكل طلب.**

*One Arabic AI platform that picks the right model for every request: chat, fashion and interior design, image generation and editing, coding, and research, in a fully Arabic, right-to-left interface.*

## المميزات

- **7 مساحات عمل:** TagSeed AI، تصميم الأزياء، الديكور والأثاث، استوديو الصور، تحليل الصور، البرمجة، الأبحاث والكتابة. لكل مساحة تعليماتها ومستوى نموذجها ومحادثاتها.
- **موجّه ذكي:** كل طلب بيروح لمستوى سريع أو متوازن أو قوي حسب نوعه، ولو النموذج الأقوى عليه ضغط بيتحوّل للسريع تلقائيًا.
- **صور من الشات:** اطلب صورة أو صِف تصميم وهتطلع صورة في الرد، مع زرار "تعديل في المحرر".
- **استوديو الصور:** طبقات، نص، أشكال، فرشاة، سطوع وتباين وتشبّع، تراجع وإعادة، تصدير PNG، وإرسال الصورة المتعدّلة للشات.
- **مرفقات:** صور، PDF، صوت، وملفات نصية وأكواد (حتى 5 ملفات في الرسالة).
- **شات صوتي:** سجّل رسالتك بصوتك، والرد بيتقري بصوت عربي.
- **حسابات:** تسجيل بتفاصيل كاملة، صفحة إعدادات، تغيير كلمة المرور، مسح المحادثات وحذف الحساب.
- **مجاني بحد يومي:** 20 طلبًا و5 صور و60 قراءة صوتية لكل مستخدم يوميًا (قابلة للتعديل).

## التقنيات

| الجزء | التقنية |
| --- | --- |
| الواجهة | React + Vite، والمحرر على Fabric.js |
| الخادم | FastAPI (Python) + SQLite |
| النماذج | Google Gemini (نص، صوت، صور)، مع دعم Anthropic وOpenRouter |
| الصور المجانية | Pollinations (من غير مفتاح) |
| الأمان | bcrypt لكلمات المرور، JWT للجلسات، حدود يومية للاستخدام |

## التشغيل على جهازك (Windows)

المطلوب: Python 3.12 وNode.js.

**الخادم:**

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
copy .env.example .env
```

افتح `backend\.env` وحط مفتاح Gemini المجاني من [Google AI Studio](https://aistudio.google.com) في `GEMINI_API_KEY`، وغيّر `JWT_SECRET` لنص عشوائي طويل.

**الواجهة:**

```powershell
cd frontend
npm install
```

**التشغيل من VS Code:** افتح الفولدر ودوس **F5** (إعداد "Tagseed (Chrome)")، هيشغّل الخادم والواجهة ويفتح الموقع على `http://localhost:5173`.

**أو يدويًا** في نافذتين:

```powershell
backend\.venv\Scripts\python -m uvicorn main:app --app-dir backend --reload --port 8000
```

```powershell
cd frontend; npm.cmd run dev
```

للتأكد إن الخادم متظبط: افتح `http://localhost:8000/api/health` وشوف `"configured": true`.

## ملاحظات

- الخطة المجانية لـ Gemini ليها حدود يومية لكل نموذج، فالموقع بيحوّل للنموذج السريع لو الأقوى خلص حده.
- الصور المجانية من Pollinations بدقة 768 وعليها علامة مائية؛ مفتاح مجاني منهم في `POLLINATIONS_TOKEN` بيحسّنها. تعديل صورة موجودة بالذكاء الاصطناعي محتاج تفعيل الدفع على Google.
- ملف `.env` وقواعد البيانات مش بيترفعوا على GitHub (شوف `.gitignore`).
