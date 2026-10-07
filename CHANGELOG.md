# 📜 تاریخچه تغییرات و نسخه‌های مخزن اختصاصی ورکر ۳ (Market AI Interpreter)

---

## [v4.0.0-phase2-3b] — حافظه کاری معنایی و ماشین حالت چندنوبته در ورکر ۳ (Phase 2-3B: Working Memory & Multi-Turn Anaphora State Machine)
* درج بلوک کامل Phase 2-3B در ورکر ۳ به‌صورت **تولید مکانیکی از ماژول مرجع** `js/engine/intent-entity-engine.js` — هم‌ارزی رفتاری تضمین‌شده و بدون منطق resolver موازی یا دست‌نویس متفاوت.
* تثبیت `WM_CONTRACT_VERSION = '1.0'`، حالت‌های `IDLE, ASSET_CONTEXT, TOPIC_CONTEXT, SCENARIO_CONTEXT, COMPARISON_CONTEXT, AWAITING_CLARIFICATION, RESTRICTED, EXPIRED` و سقف‌های ساختاری (`topicStack=3`, `scenarioLedger=4`, `TTL=3`).
* فعال‌سازی `resolveTurn` / `resolveTurnSequence` / `formatMemoryLog` در سطح اسکریپت ورکر با اتصال به پارسر What-If موجود (`parseWhatIfQuery`) — بدون تجزیه موازی و بدون ساخت مسیر استدلال دوم.
* اعتبارسنجی و ترمیم حافظه: صفر نگهداری قیمت بازار/مقدار مشتق/درصد/اسپرد/حباب/snapshot/evidence؛ تشخیص کلید ممنوعه، کلید ناشناخته، عدد مشکوک بازار و توکن عددی بزرگ.
* مرزهای اعتماد `USER_TEXT` / `SYSTEM_STATE` / `DETERMINISTIC_STATE` / `EVIDENCE` / `LLM_OUTPUT` و حذف کانال دستیار از بافت ورودی موتور؛ متن دستیار نمی‌تواند واقعیت عددی بازار را وارد state کند.
* به‌روزرسانی `WORKER_PHASE` به `Phase 2-3B (Working Memory & Multi-Turn Anaphora State Machine)` و اعلام قابلیت `workingMemory` در `GET /api/health` (با حفظ `WORKER_VERSION` جهت سازگاری گاردریل).
* حفظ کامل لایه‌های پیشین: قرارداد جامع شواهد فاز ۲-۲، بازیابی دانش فاز ۲-۱، موتور نیت/موجودیت فاز ۱-۲ و نرمال‌ساز/شبیه‌ساز فاز ۱-۱ (بدون تغییر رفتار).
* حفظ ممنوعیت‌های دامنه: بدون Structured Outputs، بدون Vectorize، بدون تغییر اسکیمای D1 (صرفاً `SELECT`)، بدون KV/Durable Object و بدون ماندگاری گفتگو در ورکر (ورکر در این فاز Stateless می‌ماند).
* افزودن سوئیت `tests/test_v247_working_memory.js` (**۶۶ آزمون رفتاری**) و پاس شدن ۱۰۰٪ کل **۵۳ سوئیت آزمون جامع QA** بدون هیچ رگرسیون در فازهای پیشین.

## [v4.0.0-phase2-2] — سازنده یکپارچه شواهد و قرارداد جامع شواهد (Unified Evidence Builder Core & Grounded Evidence Contract v1.0)
* ایجاد ماژول مستقل `js/engine/evidence-builder.js` به‌عنوان لایه جمع‌آوری، نرمال‌سازی، طبقه‌بندی، ثبت اصالت (`provenance`)، حذف تکرار و کنترل کیفیت شواهد (نه موتور استدلال و نه LLM).
* تثبیت قرارداد جامع شواهد (`Unified Evidence Contract v1.0`) شامل `contractVersion`, `query`, `dependencyPlan`, `capabilities`, `evidence`, `meta` به‌صورت دترمینیستیک و ماشین‌خوان.
* فعال‌سازی لایه‌های شواهد `LIVE`, `DERIVED`, `HYPOTHETICAL`, `KNOWLEDGE` و تعریف `HISTORICAL` و `EXTERNAL` صرفاً به‌عنوان نقاط توسعه (Extension Point) بدون هیچ پیاده‌سازی موتور، fetch بیرونی، تلگرام یا جست‌وجوی وب.
* پیاده‌سازی مدل قابلیت شواهد (`requiredEvidence` / `availableEvidence` / `missingEvidence`) و پرچم `degraded` به‌عنوان وضعیت درجه‌یک سیستم («نبود شواهد، خودش یک داده است»).
* اعمال فیلتر مرتبط‌بودن بر اساس برنامه وابستگی شواهد (Relevant Evidence — نه Maximum Evidence) شامل حذف داده زنده در پرسش‌های صرفاً دانشنامه‌ای و محدودسازی کامل در وضعیت ضدسیگنال.
* حذف تکرار دترمینیستیک بر کلید `type + asset + unit + value + source` و کشف تناقض منابع با ثبت `conflictsDetected` و `conflictTrace` (بدون بازنویسی خاموش).
* حفظ کامل ایمنی واحد (`Unit Safety`): هیچ تبدیل واحدی در بیلدر انجام نمی‌شود و ردیابی ممیزی تبدیل (`auditTrace`) نرمال‌ساز فاز ۱-۱ حفظ می‌گردد.
* افزودن اندپوینت `POST /api/ai/evidence/build` و بازگرداندن قرارداد شواهد در پاسخ‌های `POST /api/ai/chat` (شامل قرارداد محدود گاردریل ضدسیگنال).
* حفظ ممنوعیت‌های دامنه: بدون Structured Outputs، بدون Vectorize، بدون تغییر اسکیمای D1 (صرفاً `SELECT`)، بدون بازنویسی معماری LLM و بدون تغییر رفتار موتورهای قطعی.
* افزودن `inputs` به متادیتای تمام شواهد اشتقاقی جهت ردیابی کامل محاسبه (formula + inputs + provenance).
* استقرار واقعی روی Cloudflare Workers (`market-ai-interpreter`) از طریق Workers Builds پس از push به GitHub.
* ممیزی زنده نسخه مستقر: **۵۲/۵۲ آزمون پاس (۱۰۰٪)** — قرارداد شواهد، لایه‌های فعال، ایمنی، رگرسیون فازهای پیشین و پایداری.
* ایجاد سوئیت اختصاصی `tests/test_v246_evidence_builder.js` (۳۶ آزمون) و پاس شدن ۱۰۰٪ کل **۵۲ سوئیت آزمون جامع QA**.

---

## [v4.0.0-vision-doc-4] — انطباق با سند چشم‌انداز و نقشه راه معماری شماره ۴ (Vision Document No. 4 Alignment)
* تثبیت مبانی معماری نسل ۴ ورکر ۳ و استقرار موفق بر بستر Cloudflare Workers با اتصال دوگانه D1.
* انطباق کامل با نقشه راه فازهای ۲-۲ تا ۴-۱.

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
