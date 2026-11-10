# نقطة دخول Vercel: كل طلبات /api بتتحوّل هنا (vercel.json) وبتتنفّذ بنفس تطبيق FastAPI بتاع backend/
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

from main import app  # noqa: E402,F401
