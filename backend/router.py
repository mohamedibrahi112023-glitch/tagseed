"""Router بسيط بقواعد: يصنف الطلب ويرجّع مستوى النموذج. نطوره لاحقًا (classifier / تقييم نتائج)."""
CODE_HINTS = ("```", "def ", "class ", "traceback", "select ", "python", "sql", "bug", "error",
              "كود", "برمجة", "برنامج", "خطأ")
HARD_HINTS = ("حلل", "قارن", "خطة", "استراتيجية", "اشرح بالتفصيل",
              "analyze", "compare", "plan", "design", "strategy")

def pick_tier(text: str) -> str:
    t = text.lower()
    if any(k in t for k in CODE_HINTS):
        return "strong"
    if len(t) > 600 or any(k in t for k in HARD_HINTS):
        return "balanced"
    return "fast"
