# 📜 تاریخچه تغییرات و نسخه‌های مخزن اختصاصی ورکر ۳ (Market AI Interpreter)

---

## [v4.0.0-phase2-1] — هسته بازیابی قطعی دانش کلان اقتصادی و اتصال مستقیم به D1 (Knowledge Retrieval Core & Multi-Level D1 Ranking)
* اتصال کانونیکال `knowledgeQuery` به پایگاه داده `market_knowledge_db` (جدول `knowledge_base`) در D1.
* پیاده‌سازی الگوریتم رتبه‌بندی قطعی ۵‌سطحی (`Exact Topic` > `Exact Keyword` > `Title Match` > `Summary Match` > `Category Scope`).
* تفکیک دامنه دسته‌بندی (`Category Scoping`) جهت کاهش نویز کانتکست و افزایش دقت بازیابی.
* اعمال سقف سخت‌گیرانه کانتکست (`Context Cap`: حداکثر ۲ نتیجه برتر).
* مدیریت ایمن خطای D1 با بازگشت نتیجه خالی کنترل‌شده (بدون توهم یا تولید دانش جعلی / Zero Hallucination).
* افزودن اندپوینت `POST /api/ai/knowledge/retrieve` جهت استعلام و تست بلادرنگ بازیابی دانش.
* تضمین نفوذناپذیری در برابر تزریق پرامپت (تلقی محتوای دانشنامه صرفاً به عنوان داده/Evidence).

---

## [v4.0.0-phase1-2] — یکپارچه‌سازی موتور طبقه‌بندی نیت، استخراج موجودیت، تفکیک مقیاس پویا و برنامه وابستگی شواهد (Intent & Entity Engine v4)
* اصلاح و پیاده‌سازی تفکیک مقیاس پویا بر مبنای تورم روز (پشتیبانی پایدار از دلار ۲۶۸ هزار تومانی و طلای ۲۶.۵۵ میلیونی).
* طبقه‌بندی مقاصد کاربری (Intent Taxonomy: MARKET_STATUS, WHAT_IF, CALCULATION, KNOWLEDGE_QUERY, COMPARISON, PORTFOLIO_CONTEXT, CLARIFICATION_REQUIRED, ANTI_SIGNAL_RESTRICTED).
* نگاشت متمرکز موجودیت‌ها (Asset Taxonomy: USD, USDT, GOLD18, COIN, XAU, XAG, OIL, TSE_INDEX, TSE_EQUAL, BTC, ETH, SOL, DXY).
* آگاهی از بستر مکالمه و حل ارجاعات ضمیری (Referential Resolution).
* برنامه وابستگی شواهد زنده (Evidence Dependency Plan: Required & Optional).
* آمادگی استعلام‌های دانشنامه برای فاز ۲ (Knowledge Pre-RAG).

---

## [v4.0.0-phase1-1] — یکپارچه‌سازی قرارداد داده کانونیکال، نرمال‌ساز مالی و موتور شبیه‌ساز قطعی What-If (Deterministic What-If Engine v4)
* پیاده‌سازی لایه نرمال‌سازی کانونیکال ورودی‌ها (ارقام فارسی/عربی، ریال/تومان، ردپای تبدیل Audit Trace).
* تحلیل نحوی و معنایی عبارات شرطی فارسی (Semantic Shock Parser: درصد، مقادیر مطلق، اهداف قیمتی، نصف/دوبرابر، ضرایب هزار/میلیون).
* اجرای ۱۰۰٪ دترمینیستیک فرمول‌های کانونیکال ارزش ذاتی و محاسبات سناریویی بدون اتکا به LLM.
* امکان مقایسه تطبیقی دو سناریوی مفروض هم‌زمان (Scenario A vs Scenario B).
* حفظ کامل ساختار ۳ لایه روایت و گاردریل ضدسیگنال.

---

## [v3.0.0] — نسخه اولیه استقرار مستقل در گیت‌هاب و بیلد خودکار کلودفلر
* استقرار مستقیم از طریق Cloudflare Workers Builds.
* اتصال به دیتابیس‌های دوگانه D1 و هوش مصنوعی لبه Workers AI.
