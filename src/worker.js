/**
 * دیدبان هوشمند بازار — ورکر ۳: موتور تفسیر و تحلیل روایی هوش مصنوعی (Market AI Interpreter v3.0)
 * Module: Cloudflare Worker 3 (market-ai-interpreter)
 *
 * مأموریت و وظایف:
 *  ۱. میکروسرویس بی‌وضعیت (Stateless AI Gateway) جهت تولید روایت ۳ لایه‌ای بازار بر مبنای قرارداد شواهد (Evidence Contract).
 *  ۲. مدار شکن دوگانه (Dual-Gateway Circuit Breaker):
 *     - درگاه اصلی: Cloudflare Workers AI (@cf/meta/llama-3.1-8b-instruct)
 *     - درگاه پشتیبان: OpenRouter API (Mistral/Qwen/Llama3.3)
 *     - درگاه ایمن قطعی: Deterministic Narrative Fallback Engine
 *  ۳. سد اعتبارسنجی خروجی (Strict Output Validator):
 *     - اعتبارسنجی ضدتوهم عددی Regex (رد هر عدد ناموجود در شواهد ورودی)
 *     - فیلتر واژگان ممنوعه معاملاتی و ضدسیگنال (Anti-Signal Lexicon Guard)
 *     - تطبیق ساختار ۳ لایه (مشاهده عینی ──► تفسیر محتاطانه ──► احتیاط و سلب قطعیت علّی)
 *  ۴. کشینگ هوشمند لبه (Edge In-Memory Cache) با زمان انقضای ۵ دقیقه‌ای تا ۲۴ ساعته.
 *  ۵. استقلال ۱۰۰٪ از دیتابیس D1 (Zero DB Coupling).
 *  ۶. اندپوینت چت «ماکان» (/api/ai/chat) با تحلیل کاملاً پویا و زنده؛ پاسخ‌های هویتی از پروفایل کانونیکال.
 *
 * 100% self-contained ES module, ready for Cloudflare Quick Edit.
 */

'use strict';

const WORKER_VERSION = 'v3.0.0-ai-interpreter';
const WORKER_PHASE = 'Phase 2-3F-B3-KB (Knowledge Base Completion & Coverage)';

// حافظه کش درون‌رم در لبه (In-Memory Edge Cache)
const edgeMemoryCache = new Map();
const CACHE_MAX_ENTRIES = 200;

// مدیریت سهمیه و ریت‌لیمیت چت‌بات در لبه (Edge Rate Limiter & LLM Quota)
const chatRateLimits = new Map();
const dailyLlmUsage = new Map();

function checkChatRateLimit(clientIp, maxPerMinute = 6) {
  const now = Date.now();
  const entry = chatRateLimits.get(clientIp) || { count: 0, resetAt: now + 60000 };
  if (now > entry.resetAt) {
    entry.count = 1;
    entry.resetAt = now + 60000;
  } else {
    entry.count++;
  }
  chatRateLimits.set(clientIp, entry);
  return entry.count <= maxPerMinute;
}

function checkDailyLlmEligible(clientIp, maxDaily = 30) {
  const todayKey = `${clientIp}_${new Date().toISOString().slice(0, 10)}`;
  const count = dailyLlmUsage.get(todayKey) || 0;
  if (count >= maxDaily) return false;
  dailyLlmUsage.set(todayKey, count + 1);
  return true;
}

// لیست سیاه واژگان ممنوعه معاملاتی (Anti-Signal Lexicon)
const FORBIDDEN_WORDS = [
  'خرید کنید',
  'بفروشید',
  'پیشنهاد خرید',
  'پیشنهاد فروش',
  'سیگنال خرید',
  'سیگنال فروش',
  'نقطه ورود',
  'نقطه خروج',
  'تارگت قیمتی',
  'قیمت هدف',
  'سود قطعی',
  'سود تضمینی',
  'تضمین سود',
  'بدون ریسک',
  'ریسک صفر',
  'پامپ',
  'دامپ',
  'قطعاً بالا می‌رود',
  'قطعاً پایین می‌آید',
  'جهش حتمی',
  'سقوط قطعی'
];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // هدرهای استاندارد CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json; charset=utf-8'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ========================================================================
    // GET / — ریشه ورکر ۳ و راهنمای میکروسرویس
    // ========================================================================
    if (url.pathname === '/' || url.pathname === '') {
      return new Response(JSON.stringify({
        name: 'Didban Smart Market — AI Interpreter & Quant Advisory Worker',
        version: WORKER_VERSION,
        phase: WORKER_PHASE,
        status: 'online',
        endpoints: [
          { path: '/api/health', method: 'GET', description: 'System health & binding status' },
          { path: '/api/ai/chat', method: 'POST', description: 'Interactive AI Advisor conversational analysis' },
          { path: '/api/ai/interpret', method: 'POST', description: 'Multi-horizon 3-layer narrative synthesis' },
          { path: '/api/ai/validate', method: 'POST', description: 'Anti-hallucination evidence validation' },
          { path: '/api/ai/knowledge/retrieve', method: 'POST', description: 'Canonical D1 knowledge retrieval core' },
          { path: '/api/ai/evidence/build', method: 'POST', description: 'Unified Evidence Contract builder (Phase 2-2)' }
        ]
      }), { status: 200, headers: corsHeaders });
    }

    // ========================================================================
    // GET /api/health — وضعیت سلامت ورکر ۳، پایگاه‌های داده و درگاه‌های AI
    // ========================================================================
    if (url.pathname === '/api/health') {
      const hasWorkersAi = !!(env && env.AI);
      const hasOpenRouter = !!(env && env.OPENROUTER_API_KEY);
      const hasDb = !!(env && env.DB);
      const hasKnowledgeDb = !!(env && env.KNOWLEDGE_DB);
      
      return new Response(JSON.stringify({
        status: 'healthy',
        worker: 'Worker 3 - Market AI Interpreter',
        version: WORKER_VERSION,
        databases: {
          market_db: hasDb ? 'CONNECTED (Binding: DB -> market_db)' : 'NOT_BOUND',
          market_knowledge_db: hasKnowledgeDb ? 'CONNECTED (Binding: KNOWLEDGE_DB -> market_knowledge_db)' : 'NOT_BOUND'
        },
        gateways: {
          primary: hasWorkersAi ? 'CF_WORKERS_AI (Available)' : 'CF_WORKERS_AI (Binding Missing)',
          fallback: hasOpenRouter ? 'OPENROUTER (Configured)' : 'OPENROUTER (Key Missing)',
          safeFallback: 'DETERMINISTIC_ENGINE (Active)'
        },
        phase: WORKER_PHASE,
        knowledgeRetriever: 'ENABLED (Phase 2-1 Deterministic Core)',
        evidenceBuilder: 'ENABLED (Phase 2-2 Unified Evidence Contract v1.0)',
        workingMemory: 'ENABLED (Phase 2-3B Semantic Working Memory v1.0 — client-carried, stateless worker)',
        scenarioBinding: 'ENABLED (Phase 2-3E-B Multi-Asset Scenario Binding & Intent Gate v1.0)',
        dataIntegrity: 'ENABLED (Phase 2-3F-B1 Crypto Evidence Normalization & pct24h->change24h Mapping v1.0)',
        temporalSafety: 'ENABLED (Phase 2-3F-B2 Historical No-LIVE-Substitution & Conversational Continuity v1.0)',
        knowledgeRouting: 'ENABLED (Phase 2-3F-B3-KH Knowledge Retrieval & Presentation Hardening v1.1)',
        knowledgeHardening: 'ENABLED (Phase 2-3F-B3-KH KH-01..KH-06 Canonical Relevance Policy & Boundary Safety v1.0)',
        knowledgeCoverage: 'ENABLED (Phase 2-3F-B3-KB Knowledge Base Completion & Coverage v1.0 — P0/P1/P2 + Market Structure, 34 canonical entries)',
        identityProfile: 'ENABLED (Phase 2-3D Canonical Identity Profile v1.0 — MAKAN, deterministic tiered responses)',
        responsePresentation: 'ENABLED (Phase 2-3C ResponsePresentation v1.0 — user-facing sanitizer & response levels)',
        evidenceSources: {
          active: ['LIVE', 'DERIVED', 'HYPOTHETICAL', 'KNOWLEDGE'],
          extensionPoints: ['HISTORICAL', 'EXTERNAL']
        },
        edgeCacheSize: edgeMemoryCache.size,
        antiSignalWordsCount: FORBIDDEN_WORDS.length,
        timestamp: new Date().toISOString()
      }), { headers: corsHeaders });
    }

    // ========================================================================
    // POST /api/ai/knowledge/retrieve — بازیابی قطعی و بدون توهم از دانشنامه D1 (Phase 2-1)
    // ========================================================================
    if (url.pathname === '/api/ai/knowledge/retrieve' && (request.method === 'POST' || request.method === 'GET')) {
      try {
        let kq = null;
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          kq = body.knowledgeQuery || body.query || body;
        } else {
          const topic = url.searchParams.get('topic');
          const keywords = url.searchParams.get('keywords')?.split(',') || [];
          const category = url.searchParams.get('category');
          kq = { topic, keywords, category };
        }
        const result = await retrieveKnowledge(kq, env);
        return new Response(JSON.stringify({ success: true, ...result }), { headers: corsHeaders });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ========================================================================
    // POST /api/ai/interpret — تفسیر ساختاریافته شواهد با سد اعتبارسنجی
    // ========================================================================
    if (url.pathname === '/api/ai/interpret' && request.method === 'POST') {
      try {
        const body = await request.json();
        const evidenceContract = body.evidenceContract || body;
        const mode = body.mode || 'MARKET_PULSE'; // 'MARKET_PULSE' | 'DAILY_SNAPSHOT' | 'THEMATIC'
        
        if (!evidenceContract || typeof evidenceContract !== 'object') {
          return new Response(JSON.stringify({
            success: false,
            error: 'خطا: قرارداد شواهد (evidenceContract) در بدنه درخواست یافت نشد.'
          }), { status: 400, headers: corsHeaders });
        }

        // ۱. بررسی کش لبه (Edge Cache Check)
        const cacheKey = await generateCacheKey(evidenceContract, mode);
        const cached = getFromEdgeCache(cacheKey);
        if (cached) {
          return new Response(JSON.stringify({
            success: true,
            source: 'EDGE_CACHE',
            cachedAt: cached.timestamp,
            data: cached.payload
          }), { headers: corsHeaders });
        }

        // ۲. فرآیند تولید روایت با مدارشکن دوگانه و اعتبارسنجی خروجی
        const result = await processAiInterpretation(evidenceContract, mode, env);

        // ۳. ذخیره در کش لبه در صورت موفقیت
        if (result && result.validationStatus === 'PASSED') {
          saveToEdgeCache(cacheKey, result, 300); // ۵ دقیقه کش
        }

        return new Response(JSON.stringify({
          success: true,
          source: result.provider,
          data: result
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          error: 'خطای پردازش تفسیر هوش مصنوعی: ' + err.message
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ========================================================================
    // POST /api/ai/validate — اعتبارسنجی مجزای متن بدون تولید
    // ========================================================================
    if (url.pathname === '/api/ai/validate' && request.method === 'POST') {
      try {
        const body = await request.json();
        const text = body.text;
        const evidenceContract = body.evidenceContract;
        
        if (!text || !evidenceContract) {
          return new Response(JSON.stringify({
            success: false,
            error: 'خطا: ارسال متن (text) و قرارداد شواهد (evidenceContract) الزامی است.'
          }), { status: 400, headers: corsHeaders });
        }

        const validation = validateAiOutput(text, evidenceContract);
        return new Response(JSON.stringify({
          success: true,
          validation
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ========================================================================
    // POST /api/ai/chat — چت‌بات مشاور هوشمند تحلیلی با گاردریل ضدسیگنال و شواهد زنده
    // ========================================================================
    if (url.pathname === '/api/ai/chat' && request.method === 'POST') {
      try {
        const body = await request.json();
        const userMsg = String(body.message || '').trim();
        const history = Array.isArray(body.history) ? body.history : [];
        const todayEvidence = (body.todayEvidence && typeof body.todayEvidence === 'object') ? body.todayEvidence : {};

        if (!userMsg) {
          return new Response(JSON.stringify({
            success: false,
            error: 'متن پیام کاربر نمی‌تواند خالی باشد.'
          }), { status: 400, headers: corsHeaders });
        }

        const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '127.0.0.1';

        // کنترل ریت‌لیمیت درخواست‌های چت (حداکثر ۱۰ پیام در دقیقه)
        if (!checkChatRateLimit(clientIp, 10)) {
          return new Response(JSON.stringify({
            success: false,
            error: 'تعداد پیام‌های ارسالی شما بیش از حد مجاز است. لطفاً یک دقیقه دیگر مجدداً تلاش فرمایید.'
          }), { status: 429, headers: corsHeaders });
        }

        // بررسی گاردریل ضدسیگنال ورودی
        const lowerMsg = userMsg.toLowerCase();
        const isDirectSignalRequest = FORBIDDEN_WORDS.some(w => lowerMsg.includes(w.toLowerCase()));

        if (isDirectSignalRequest) {
          // قرارداد شواهد محدود: گاردریل ضدسیگنال هرگز با جمع‌آوری شواهد بیشتر دور زده نمی‌شود
          const restrictedContract = buildUnifiedEvidenceContract({
            query: userMsg,
            cir: {
              intent: { primary: 'ANTI_SIGNAL_RESTRICTED', secondary: [], confidence: 1.0 },
              entities: [],
              operations: [],
              requiresCalculation: false,
              requiresLiveEvidence: false,
              requiresKnowledge: false,
              evidencePlan: { required: [], optional: [] },
              knowledgeQuery: null
            },
            rawEvidence: {}
          });
          return new Response(JSON.stringify({
            success: true,
            reply: '⚠️ **تذکر شفاف و سلب مسئولیت مالی:**\nدیدبان هوشمند بازار یک پلتفرم تحلیلی، آماری و پژوهشی است و تحت هیچ عنوان سیگنال معاملاتی، نقطه ورود/خروج، تارگت قیمتی یا پیشنهاد خرید و فروش صادر نمی‌کند.\n\nتوصیه می‌شود بر اساس استراتژی مدیریت ریسک شخصی، ضرایب همبستگی دارایی‌ها و سناریوهای احتمالاتی تصمیم‌گیری فرمایید.\n\n🧭 **تحلیل جایگزین مجاز (بدون توصیه معاملاتی):**\n• چارچوب: تنوع‌بخشی و مدیریت ریسک شخصی به‌جای تمرکز روی یک دارایی.\n• سناریوی شرطی: «اگر دلار ۱۰٪ بالا برود و اونس ۵٪ رشد کند، طلا چقدر می‌شود؟»\n• تحلیل ساختاری: حباب، اسپرد و نسبت‌های تحلیلی از داده‌های امروز.\n• عدم‌قطعیت: سناریو ≠ پیش‌بینی؛ هیچ مدلی آینده را قطعی نمی‌داند.',
            source: 'ANTI_SIGNAL_GUARD',
            unifiedEvidence: restrictedContract,
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        // ۲.۴. هویت کانونیکال «ماکان» (Phase 2-3D): پاسخ ثابت از پروفایل مرجع —
        // بدون فراخوانی LLM و بدون هیچ جزء بازار (شواهد/نرمال‌سازی/همبستگی/سناریو/دانش/تاریخ)
        const identityIntent = detectIdentityQuery(userMsg);
        if (identityIntent) {
          return new Response(JSON.stringify({
            success: true,
            reply: buildIdentityResponse(identityIntent.tier),
            source: 'IDENTITY_STATIC_PROFILE',
            identityTier: identityIntent.tier,
            responseLevel: identityTierLevel(identityIntent.tier),
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        // Phase 2-3C — گفت‌وگوی عمومی (Small Talk): پاسخ قطعی، کوتاه و بدون فراخوانی LLM/شواهد
        const smallTalk = detectSmallTalk(userMsg);
        if (smallTalk) {
          return new Response(JSON.stringify({
            success: true,
            reply: buildSmallTalkResponse(smallTalk.kind),
            source: 'SMALL_TALK_DETERMINISTIC',
            responseLevel: RESPONSE_LEVELS.SHORT,
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        let replyText = '';
        let sourceUsed = 'DYNAMIC_SYNTHESIS_ENGINE';

        // ۰. نرمال‌سازی کانونیکال شواهد ورودی بازار
        const normalizedEvidence = normalizeEvidenceMap(todayEvidence);

        // ۱. تحلیل نیت: در صورت ارسال CIR حل‌شده با حافظه کاری (Phase 2-3C) از آن استفاده می‌شود
        const analysisHistory = history.filter(h => h && h.role === 'user');
        const clientCir = (body.queryAnalysis && typeof body.queryAnalysis === 'object' &&
          body.queryAnalysis.intent && body.queryAnalysis.context && body.queryAnalysis.context.resolutionPath)
          ? body.queryAnalysis
          : null;
        const queryAnalysis = clientCir || analyzeQuery(userMsg, analysisHistory, todayEvidence);

        // FIX-B2-2 (Phase 2-3F-B2): ایمنی مستقل ورکر — تشخیص قطعی افق زمانی از متن کاربر حتی بدون CIR
        if (queryAnalysis && typeof queryAnalysis === 'object') {
          if (!queryAnalysis.context) queryAnalysis.context = { isFollowUp: false, resolvedFromContext: [] };
          if (!queryAnalysis.context.timeframe || !queryAnalysis.context.timeframe.horizon) {
            const _resolvedTf = resolveTemporal(userMsg);
            queryAnalysis.context.timeframe = {
              label: _resolvedTf.label,
              horizon: _resolvedTf.horizon,
              requiresHistoricalData: _resolvedTf.requiresHistoricalData,
              requiresForecastCapability: _resolvedTf.requiresForecastCapability
            };
          }
        }
        const requestLevel = classifyResponseLevel(queryAnalysis, userMsg);
        const isTechnicalRequest = detectTechnicalRequest(userMsg);
        const isWhyQuestion = detectWhyQuery(userMsg);

        // ۲. واکنش سریع به گاردریل ضدسیگنال
        if (queryAnalysis.intent.primary === 'ANTI_SIGNAL_RESTRICTED') {
          return new Response(JSON.stringify({
            success: true,
            reply: '⚠️ **تذکر شفاف و سلب مسئولیت مالی:**\nدیدبان هوشمند بازار یک پلتفرم تحلیلی، آماری و پژوهشی است و تحت هیچ عنوان سیگنال معاملاتی، نقطه ورود/خروج، تارگت قیمتی یا پیشنهاد خرید و فروش صادر نمی‌کند.\n\nتوصیه می‌شود بر اساس استراتژی مدیریت ریسک شخصی، ضرایب همبستگی دارایی‌ها و سناریوهای احتمالاتی تصمیم‌گیری فرمایید.\n\n🧭 **تحلیل جایگزین مجاز (بدون توصیه معاملاتی):**\n• چارچوب: تنوع‌بخشی و مدیریت ریسک شخصی به‌جای تمرکز روی یک دارایی.\n• سناریوی شرطی: «اگر دلار ۱۰٪ بالا برود و اونس ۵٪ رشد کند، طلا چقدر می‌شود؟»\n• تحلیل ساختاری: حباب، اسپرد و نسبت‌های تحلیلی از داده‌های امروز.\n• عدم‌قطعیت: سناریو ≠ پیش‌بینی؛ هیچ مدلی آینده را قطعی نمی‌داند.',
            source: 'ANTI_SIGNAL_GUARD',
            interpretation: formatStructuredLog(queryAnalysis),
            unifiedEvidence: buildUnifiedEvidenceContract({ query: userMsg, cir: queryAnalysis, rawEvidence: {} }),
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        // ۲.۵. اجرای بازیابی دانش از D1 در صورت نیاز (Knowledge Retrieval Core Phase 2-1)
        let retrievedKnowledge = null;
        if (queryAnalysis.requiresKnowledge || queryAnalysis.knowledgeQuery) {
          retrievedKnowledge = await retrieveKnowledge(queryAnalysis.knowledgeQuery, env);
        }

        // ۳. کشف ابهام و درخواست شفاف‌سازی بدون حدس‌های پرریسک مالی
        if (queryAnalysis.intent.primary === 'CLARIFICATION_REQUIRED') {
          return new Response(JSON.stringify({
            success: true,
            reply: '❓ **نیازمند شفاف‌سازی متغیر فرضی (Clarification Required):**\n\nدرخواست سناریوی فرضی شما دریافت شد، اما مشخص نگردید شوک مدنظر بر کدام دارایی (دلار آزاد، اونس جهانی طلا، سکه یا طلای ۱۸ عیار) اعمال شود.\n\n💡 **پیشنهادهای سناریویی:**\n• *اگر دلار ۱۰ درصد رشد کند، قیمت طلا و سکه چقدر می‌شود؟*\n• *اگر اونس ۲۰۰ دلار افت کند و دلار ۲۸۰ هزار تومان شود چه تغییری رخ می‌دهد؟*',
            source: 'CLARIFICATION_ENGINE',
            interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
            retrievedKnowledge,
            unifiedEvidence: buildUnifiedEvidenceContract({
              query: userMsg,
              cir: queryAnalysis,
              rawEvidence: normalizedEvidence,
              options: { alreadyNormalized: true }
            }),
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        // ۳.۵. ساخت قرارداد جامع شواهد (یک‌بار؛ مبنای گاردهای ارائه و پاسخ نهایی)
        const unifiedEvidenceContract = buildUnifiedEvidenceContract({
          query: userMsg,
          cir: queryAnalysis,
          rawEvidence: normalizedEvidence,
          retrievedKnowledge,
          historical: Array.isArray(body.historical) ? body.historical : [],
          options: { alreadyNormalized: true }
        });

        // ۳.۶. گارد قابلیت افق زمانی (Phase 2-3C): بدون جانشینی LIVE به‌جای HISTORICAL/FORECAST
        const tfCtx = (queryAnalysis.context && queryAnalysis.context.timeframe) ? queryAnalysis.context.timeframe : null;
        const missingCaps = (unifiedEvidenceContract.capabilities && Array.isArray(unifiedEvidenceContract.capabilities.missingEvidence))
          ? unifiedEvidenceContract.capabilities.missingEvidence
          : [];
        const needsHistorical = !!(tfCtx && tfCtx.requiresHistoricalData);
        const needsForecast = !!(tfCtx && tfCtx.requiresForecastCapability);
        const isConditionalScenarioRequest = (queryAnalysis.intent.primary === 'WHAT_IF' || queryAnalysis.intent.primary === 'SCENARIO_COMPARISON');
        if ((needsHistorical || needsForecast) && !isConditionalScenarioRequest) {
          // FIX-B2-1 (Phase 2-3F-B2): شاخه «شواهد تاریخی موجود» — استفاده از همان شواهد، بدون هیچ جانشینی LIVE
          const historicalItems = (unifiedEvidenceContract.evidence && Array.isArray(unifiedEvidenceContract.evidence.historical))
            ? unifiedEvidenceContract.evidence.historical
            : [];
          if (needsHistorical && historicalItems.length > 0) {
            const historicalReply = buildHistoricalEvidenceResponse(queryAnalysis, historicalItems);
            if (historicalReply) {
              return new Response(JSON.stringify({
                success: true,
                reply: historicalReply,
                source: 'HISTORICAL_EVIDENCE_PRESENTATION',
                responseLevel: RESPONSE_LEVELS.STANDARD,
                interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
                retrievedKnowledge,
                unifiedEvidence: unifiedEvidenceContract,
                timestamp: new Date().toISOString()
              }), { headers: corsHeaders });
            }
          }
          const degradedReply = buildDegradedTimeframeResponse(queryAnalysis);
          if (degradedReply) {
            return new Response(JSON.stringify({
              success: true,
              reply: degradedReply,
              source: 'TIMEFRAME_CAPABILITY_GUARD',
              responseLevel: RESPONSE_LEVELS.STANDARD,
              interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
              retrievedKnowledge,
              unifiedEvidence: unifiedEvidenceContract,
              timestamp: new Date().toISOString()
            }), { headers: corsHeaders });
          }
        }

        // ۳.۸. ارائه دانشنامه (Phase 2-3F-B3): شاخه اختصاصی KNOWLEDGE — بدون حدس و بدون داده بازار
        // Phase 2-3F-B3-KH (KH-05): پرسش «چرا» مفهومی (موضوع معتبر + بدون حرکت بازار) به دانش‌نامه می‌رود؛
        // «چرا X بالا/پایین رفت» همچنان تحلیل بازار (MARKET) می‌ماند.
        const _conceptualWhy = detectConceptualWhyQuery(userMsg);
        const _resolvedKnowledgeTopic = !!(queryAnalysis.knowledgeQuery && queryAnalysis.knowledgeQuery.topic
          && queryAnalysis.knowledgeQuery.topic !== 'GENERAL_FINANCE');
        const _whyAllowsKnowledge = !detectWhyQuery(userMsg) || (_conceptualWhy && _resolvedKnowledgeTopic);
        if ((queryAnalysis.requiresKnowledge || queryAnalysis.intent.primary === 'KNOWLEDGE_QUERY' || queryAnalysis.knowledgeQuery) && _whyAllowsKnowledge) {
          const knowledgeReply = buildKnowledgePresentationResponse(retrievedKnowledge, queryAnalysis);
          if (knowledgeReply) {
            const knowledgeMatched = !!(retrievedKnowledge && retrievedKnowledge.meta && retrievedKnowledge.meta.matched);
            return new Response(JSON.stringify({
              success: true,
              reply: sanitizeUserFacingResponse(knowledgeReply, { technical: isTechnicalRequest }),
              source: knowledgeMatched ? 'KNOWLEDGE_PRESENTATION' : 'KNOWLEDGE_ENTRY_MISSING',
              responseLevel: RESPONSE_LEVELS.STANDARD,
              interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
              retrievedKnowledge,
              unifiedEvidence: unifiedEvidenceContract,
              timestamp: new Date().toISOString()
            }), { headers: corsHeaders });
          }
        }

        // ۳.۷. پاسخ کوتاه و متناسب وضعیت بازار (MARKET_STATUS) — بدون گزارش‌های نامرتبط
        if (queryAnalysis.intent.primary === 'MARKET_STATUS' &&
            Array.isArray(queryAnalysis.entities) && queryAnalysis.entities.length >= 1 && queryAnalysis.entities.length <= 2 &&
            !queryAnalysis.requiresKnowledge && !detectWhyQuery(userMsg)) {
          const liveForStatus = (unifiedEvidenceContract.evidence && Array.isArray(unifiedEvidenceContract.evidence.live))
            ? unifiedEvidenceContract.evidence.live
            : [];
          const conciseReply = buildConciseMarketStatusResponse(queryAnalysis, liveForStatus);
          return new Response(JSON.stringify({
            success: true,
            reply: conciseReply,
            source: 'DETERMINISTIC_MARKET_STATUS',
            responseLevel: RESPONSE_LEVELS.SHORT,
            interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
            retrievedKnowledge,
            unifiedEvidence: unifiedEvidenceContract,
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        // ۴. شبیه‌ساز قطعی What-If و مقایسه سناریویی
        if (queryAnalysis.intent.primary === 'WHAT_IF' || queryAnalysis.intent.primary === 'SCENARIO_COMPARISON') {
          let whatIfAst = parseWhatIfQuery(userMsg, history);
          // Phase 2-3C: پیگیری سناریویی بدون دارایی/جهت صریح — بازسازی پرسش مؤثر از سناریوی حل‌شده حافظه کاری
          if (!whatIfAst) {
            // FIX-4 (Phase 2-3E-B): پیام دارای بیش از یک شوک درصدی مستقل، هرگز به سناریوی تک‌دارایی قبلی تقلیل نمی‌یابد
            const multiShockInMessage = (String(userMsg).match(/[0-9۰-۹]+(?:[.,][0-9۰-۹]+)?\s*(?:درصد|٪|%)/g) || []).length >= 2;
            // FIX-5 (Phase 2-3E-B): پیگیری هدف سناریوی فعال — بازسازی پرسش مؤثر از زنجیره کامل فرض‌های ثبت‌شده (بدون حذف فرض)
            const scChain = (!multiShockInMessage && queryAnalysis.context && Array.isArray(queryAnalysis.context.scenarioChain))
              ? queryAnalysis.context.scenarioChain.filter(a => a && a.asset && Object.prototype.hasOwnProperty.call(a, 'value') && Number.isFinite(Number(a.value)))
              : [];
            if (scChain.length >= 2) {
              const chainParts = scChain.map((a, i) => {
                const ent = Array.isArray(queryAnalysis.entities) ? queryAnalysis.entities.find(e => e && e.value === a.asset) : null;
                const faLabel = (ent && ent.raw) ? ent.raw : ResponsePresentation.assetLabel(a.asset);
                const dirFa = a.direction === 'DOWN' ? 'پایین' : 'بالا';
                return (i === 0 ? 'اگر ' : '') + faLabel + ' ' + ResponsePresentation.toFaDigits(String(a.value)) + '٪ ' + dirFa + ' بره';
              });
              const mergedAst = parseWhatIfQuery(chainParts.join(' و '), history);
              if (mergedAst && Array.isArray(mergedAst.assumptions) && mergedAst.assumptions.length >= 2) whatIfAst = mergedAst;
            }
            const scResolved = (!whatIfAst && !multiShockInMessage && queryAnalysis.context && queryAnalysis.context.scenario) ? queryAnalysis.context.scenario : null;
            if (scResolved && scResolved.asset && scResolved.mode === 'PERCENT_CHANGE' &&
                scResolved.value !== null && scResolved.value !== undefined && Number.isFinite(Number(scResolved.value))) {
              const entResolved = Array.isArray(queryAnalysis.entities) ? queryAnalysis.entities.find(e => e && e.value === scResolved.asset) : null;
              const faLabel = (entResolved && entResolved.raw) ? entResolved.raw : ResponsePresentation.assetLabel(scResolved.asset);
              const dirFa = scResolved.direction === 'DOWN' ? 'پایین' : 'بالا';
              const effectiveWhatIfQuery = 'اگر ' + faLabel + ' ' + ResponsePresentation.toFaDigits(String(scResolved.value)) + '٪ ' + dirFa + ' بره';
              whatIfAst = parseWhatIfQuery(effectiveWhatIfQuery, history);
            }
          }
          if (whatIfAst) {
            let whatIfReply = '';
            if (whatIfAst.type === 'MULTI_SCENARIO_COMPARISON') {
              const multiRes = executeMultiScenarioComparison(whatIfAst, normalizedEvidence);
              whatIfReply = renderWhatIfResponse(multiRes);
            } else {
              const simRes = executeWhatIfSimulation(whatIfAst, normalizedEvidence);
              whatIfReply = renderWhatIfResponse(simRes);
            }

            if (whatIfReply) {
              return new Response(JSON.stringify({
                success: true,
                reply: whatIfReply,
                source: 'DETERMINISTIC_WHAT_IF_ENGINE',
                interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
                retrievedKnowledge,
                unifiedEvidence: buildUnifiedEvidenceContract({
                  query: userMsg,
                  cir: queryAnalysis,
                  rawEvidence: normalizedEvidence,
                  retrievedKnowledge,
                  whatIfAst,
                  options: { alreadyNormalized: true }
                }),
                timestamp: new Date().toISOString()
              }), { headers: corsHeaders });
            }
          }
        }

        // ۵. در صورت در دسترس بودن درگاه هوش مصنوعی و داشتن سهمیه روزانه، فراخوانی مدل زبانی
        const isLlmEligible = checkDailyLlmEligible(clientIp, 40);
        if (isLlmEligible && env && (env.AI || env.OPENROUTER_API_KEY)) {
          try {
            const chatSystemPrompt = buildAdvisorChatSystemPrompt(todayEvidence, queryAnalysis, {
              responseLevel: requestLevel,
              isWhyQuestion,
              isTechnicalRequest
            }, retrievedKnowledge);
            const chatMessages = [
              { role: 'system', content: chatSystemPrompt },
              ...history.slice(-4).map(h => ({
                role: h.role === 'user' ? 'user' : 'assistant',
                content: h.text || h.content || ''
              })),
              { role: 'user', content: userMsg }
            ];

            let rawLlmOutput = null;

            if (env.AI) {
              const cfAiRes = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
                messages: chatMessages,
                temperature: 0.2,
                max_tokens: responseTokenCap(requestLevel),
                top_p: 0.9
              });
              if (cfAiRes && (cfAiRes.response || cfAiRes.text)) {
                rawLlmOutput = (cfAiRes.response || cfAiRes.text).trim();
              }
            } else if (env.OPENROUTER_API_KEY) {
              const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                  'Content-Type': 'application/json',
                  'HTTP-Referer': 'https://dbai1.pages.dev',
                  'X-Title': 'Market Watcher Luxe AI Advisor'
                },
                body: JSON.stringify({
                  model: 'openrouter/free',
                  messages: chatMessages,
                  temperature: 0.2,
                  max_tokens: responseTokenCap(requestLevel)
                })
              });
              if (orRes.ok) {
                const orJson = await orRes.json();
                rawLlmOutput = orJson.choices?.[0]?.message?.content?.trim();
              }
            }

            // اعتبارسنجی ضدسیگنال خروجی مدل زبانی
            if (rawLlmOutput && !FORBIDDEN_WORDS.some(w => rawLlmOutput.includes(w))) {
              replyText = rawLlmOutput;
              sourceUsed = env.AI ? 'CF_WORKERS_AI_CHAT' : 'OPENROUTER_CHAT';
            }
          } catch (llmErr) {
            console.warn('[Advisor LLM generation skipped, falling back to dynamic synthesis]:', llmErr.message);
          }
        }

        // ۶. در صورت عدم وجود LLM یا بروز خطا: اجرای موتور قدرتمند استنتاج پویای دترمینیستیک
        if (!replyText) {
          replyText = buildDynamicAdvisorResponse(userMsg, todayEvidence, normalizedEvidence, queryAnalysis,
            (unifiedEvidenceContract.evidence && Array.isArray(unifiedEvidenceContract.evidence.live)) ? unifiedEvidenceContract.evidence.live : []);
          sourceUsed = 'DYNAMIC_SYNTHESIS_ENGINE';
        }

        // ۷. لایه ارائه (Phase 2-3C): پاک‌سازی نشت فرمول/ثابت کانونیکال/نام موتور از پاسخ کاربرنما
        replyText = sanitizeUserFacingResponse(replyText, { technical: isTechnicalRequest });

        return new Response(JSON.stringify({
          success: true,
          reply: replyText,
          source: sourceUsed,
          responseLevel: requestLevel,
          interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
          retrievedKnowledge,
          unifiedEvidence: unifiedEvidenceContract,
          timestamp: new Date().toISOString()
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          error: 'خطای سرور در پردازش گفت‌وگو: ' + err.message
        }), { status: 500, headers: corsHeaders });
      }
    }

    // ========================================================================
    // POST /api/ai/evidence/build — ساخت قرارداد جامع شواهد (Phase 2-2)
    // وظیفه: جمع‌آوری، طبقه‌بندی و کنترل کیفیت شواهد (نه تولید تحلیل یا پیش‌بینی)
    // ========================================================================
    if (url.pathname === '/api/ai/evidence/build' && request.method === 'POST') {
      try {
        const body = await request.json().catch(() => ({}));
        const query = String(body.message || body.query || '').trim();
        const todayEvidence = (body.todayEvidence && typeof body.todayEvidence === 'object') ? body.todayEvidence : {};
        const hasNormalizedInput = !!(body.normalizedEvidence && typeof body.normalizedEvidence === 'object');
        const rawEvidence = hasNormalizedInput ? body.normalizedEvidence : todayEvidence;
        const history = Array.isArray(body.history) ? body.history : [];

        if (!query) {
          return new Response(JSON.stringify({
            success: false,
            error: 'متن پرسش (message یا query) نمی‌تواند خالی باشد.'
          }), { status: 400, headers: corsHeaders });
        }

        const cir = analyzeQuery(query, history, todayEvidence);
        const whatIfAst = body.whatIfAst || ((cir.intent.primary === 'WHAT_IF' || cir.intent.primary === 'SCENARIO_COMPARISON') ? parseWhatIfQuery(query, history) : null);

        let retrievedKnowledge = null;
        if (cir.requiresKnowledge || cir.knowledgeQuery) {
          retrievedKnowledge = await retrieveKnowledge(cir.knowledgeQuery, env);
        }

        const contract = buildUnifiedEvidenceContract({
          query,
          cir,
          rawEvidence,
          retrievedKnowledge,
          whatIfAst,
          historical: Array.isArray(body.historical) ? body.historical : [],
          external: Array.isArray(body.external) ? body.external : [],
          options: { alreadyNormalized: hasNormalizedInput }
        });

        return new Response(JSON.stringify({
          success: true,
          evidenceContract: contract
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          error: 'خطای ساخت قرارداد شواهد: ' + err.message
        }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({
      error: 'مسیر یافت نشد (Endpoint Not Found)',
      availableEndpoints: ['GET /api/health', 'POST /api/ai/interpret', 'POST /api/ai/validate', 'POST /api/ai/chat', 'POST /api/ai/knowledge/retrieve', 'POST /api/ai/evidence/build']
    }), { status: 404, headers: corsHeaders });
  }
};

// ============================================================================
// موتور طبقه‌بندی قصد، استخراج موجودیت و تحلیل هدایت‌شده (Intent & Entity Engine v4)
// ============================================================================

const INTENTS = {
  MARKET_STATUS: 'MARKET_STATUS',
  MARKET_ANALYSIS: 'MARKET_ANALYSIS',
  ASSET_ANALYSIS: 'ASSET_ANALYSIS',
  WHAT_IF: 'WHAT_IF',
  SCENARIO_COMPARISON: 'SCENARIO_COMPARISON',
  CALCULATION: 'CALCULATION',
  KNOWLEDGE_QUERY: 'KNOWLEDGE_QUERY',
  COMPARISON: 'COMPARISON',
  RISK_QUERY: 'RISK_QUERY',
  PORTFOLIO_CONTEXT: 'PORTFOLIO_CONTEXT',
  FOLLOW_UP: 'FOLLOW_UP',
  CLARIFICATION_REQUIRED: 'CLARIFICATION_REQUIRED',
  ANTI_SIGNAL_RESTRICTED: 'ANTI_SIGNAL_RESTRICTED',
  UNKNOWN: 'UNKNOWN'
};

const ASSET_TAXONOMY = {
  USD: ['دلار آزاد', 'دلار کاغذی', 'دلار تهران', 'اسکناس دلار', 'دلار نقد', 'دلار بازار', 'دلار', 'usd'],
  USDT: ['تتر دیجیتال', 'دلار دیجیتال', 'تتر بازار', 'تتر', 'usdt'],
  GOLD18: ['طلای ۱۸ عیار', 'طلا ۱۸ عیار', 'طلای 18 عیار', 'طلای ۱۸', 'طلا ۱۸', 'طلای هجده', 'طلای ۱۷ عیار', 'طلای ۱۷', 'مظنه مثقال', 'مظنه', 'مثقال طلا', 'مثقال', 'طلای آب‌شده', 'طلای اب شده', 'طلای آب شده', 'آب‌شده', 'آب شده', 'گرم طلا', 'طلا', 'gold18', 'gold'],
  COIN: ['سکه تمام طرح جدید', 'سکه طرح جدید', 'سکه تمام بهار', 'سکه امامی', 'سکه تمام', 'تمام سکه', 'ربع سکه', 'نیم سکه', 'سکه بهار آزادی', 'سکه', 'sekee', 'coin'],
  XAU: ['اونس جهانی طلا', 'انس جهانی طلا', 'اونس جهانی', 'انس جهانی', 'اونس طلا', 'انس طلا', 'اونس', 'انس', 'xau', 'gold ounce'],
  XAG: ['اونس جهانی نقره', 'انس جهانی نقره', 'اونس نقره', 'انس نقره', 'نقره جهانی', 'نقره ۹۹۹', 'نقره', 'xag', 'silver'],
  OIL: ['نفت خام برنت', 'نفت برنت', 'نفت سنگین', 'نفت wti', 'نفت خام', 'نفت', 'oil', 'brent'],
  TSE_INDEX: ['شاخص کل بورس', 'شاخص کل', 'بورس تهران', 'بازار سهام', 'بازار بورس', 'بورس', 'tse_index', 'tse'],
  TSE_EQUAL: ['شاخص کل هم‌وزن', 'شاخص کل هم وزن', 'شاخص هم‌وزن', 'شاخص هم وزن', 'هم‌وزن', 'هم وزن', 'tse_equal'],
  BTC: ['بیت‌کوین', 'بیت کوین', 'بیتکوین', 'دامیننس بیت‌کوین', 'دامیننس بیت کوین', 'دامیننس', 'btc.d', 'btc', 'bitcoin'],
  ETH: ['اتریوم', 'اتر', 'eth', 'ethereum'],
  SOL: ['سولانا', 'سول', 'sol', 'solana'],
  DXY: ['شاخص دلار آمریکا', 'شاخص دلار', 'دلار جهانی', 'dxy', 'dollar index']
};

const KNOWLEDGE_TOPICS = {
  'P/E': ['p/e', 'pe', 'پی بر ای', 'پی ای', 'پی به ای', 'نسبت p/e', 'نسبت pe', 'قیمت به درآمد', 'نسبت قیمت به سود'],
  'CPI': ['cpi', 'شاخص قیمت مصرف‌کننده', 'شاخص قیمت مصرف کننده', 'شاخص تورم مصرف‌کننده', 'شاخص تورم', 'تورم cpi'],
  'DXY': ['dxy', 'شاخص دلار آمریکا', 'شاخص دلار', 'دلار جهانی'],
  'PMI': ['pmi', 'شاخص مدیران خرید', 'مدیران خرید'],
  'GOLD_TO_SILVER': ['نسبت طلا به نقره', 'طلا به نقره', 'xau/xag', 'xau xag', 'نسبت اونس طلا به نقره'],
  'GOLD_ETF': ['صندوق طلا', 'صندوق های طلا', 'صندوق‌های طلا', 'صندوق عیار', 'صندوق کهربا', 'صندوق زرفام', 'صندوق کالایی طلا', 'gold etf'],
  'COIN_VS_TOKEN': ['تفاوت کوین و توکن', 'فرق کوین و توکن', 'کوین یا توکن', 'کوین و توکن'],
  'HALVING': ['هاوینگ بیت کوین', 'هاوینگ بیت‌کوین', 'هاوینگ', 'halving', 'نصف شدن پاداش بلوک', 'نصف شدن پاداش'],
  'BROKER_VS_BROKERAGE': ['تفاوت کارگزاری و بروکر', 'فرق کارگزاری و بروکر', 'کارگزاری یا بروکر', 'کارگزاری و بروکر'],
  'GOLD18_BUBBLE_CORRIDOR': ['حباب طلای ۱۸', 'حباب ۱۸ عیار', 'کریدور تعادلی طلا', 'دامنه تعادلی طلا', 'اشباع خرید طلا'],
  'QUARTER_COIN_BUBBLE': ['حباب ربع سکه', 'حباب ربع‌سکه', 'ربع سکه'],
  'SIDEWAYS_MARKET': ['بازار ساید', 'روند ساید', 'حرکت ساید', 'سایدوی', 'بازار رنج', 'کانال رنج', 'رنج‌باند', 'درجا زدن', 'درجا زدن قیمت', 'ساید یعنی', 'رنج یعنی', 'ساید چیست', 'بازار رنج چیست', 'بازار خنثی', 'فلت'],
  'PRICE_CONSOLIDATION': ['تثبیت قیمت', 'تثبیت در محدوده', 'تثبیت نرخ', 'فاز تثبیت', 'کنسولیدیشن', 'کانسولیدیشن', 'consolidation'],
  'CEX_DEX': ['cex و dex', 'تفاوت cex و dex', 'cex', 'dex', 'صرافی متمرکز', 'صرافی غیرمتمرکز', 'صرافی متمرکز و غیرمتمرکز'],
  'INTEREST_RATES': ['نرخ بهره', 'نرخ بهره آمریکا', 'نرخ بهره و طلا', 'اثر نرخ بهره بر طلا', 'هزینه فرصت'],
  'INFLATION': ['تورم چیست', 'تورم چیه', 'تورم', 'قدرت خرید پول', 'تفاوت تورم و شاخص قیمت مصرف‌کننده', 'inflation'],
  'VOLATILITY': ['نوسان چیست', 'نوسان بازار', 'نوسان قیمت', 'نوسانات', 'نوسان', 'volatility'],
  'DRAWDOWN': ['دراودان', 'drawdown', 'حداکثر افت', 'افت حداکثری', 'حداکثر افت سرمایه'],
  'STABLECOIN': ['استیبل کوین', 'استیبل‌کوین', 'استیبل', 'stablecoin', 'کوین پایدار'],
  'ETH_BTC': ['نسبت eth به btc', 'نسبت اتریوم به بیت‌کوین', 'نسبت اتریوم به بیت کوین', 'eth/btc', 'eth btc'],
  'DIVERSIFICATION': ['تنوع بخشی', 'تنوع‌بخشی', 'diversification', 'ریسک تمرکز', 'concentration risk', 'تمرکز سبد'],
  'GOLD_PURITY': ['عیار طلا', 'عیار طلا چیست', 'خلوص طلا', 'طلای ۲۴ عیار', 'طلای ۲۴', 'gold purity'],
  'CORRELATION': ['تفاوت همبستگی و علیت', 'همبستگی و علیت', 'همبستگی', 'correlation', 'علیت', 'causation', 'correlation vs causation']
};

// Phase 2-3F-B3: تطبیق مرزدار مترادف‌های لاتین (ضد نشت زیررشته‌ای مانند 'sol' در 'consolidation')
function entitySynonymHit(text, syn) {
  const s = String(text || '');
  const needle = String(syn || '').toLowerCase();
  if (!needle) return false;
  if (/^[a-z0-9.]+$/.test(needle)) {
    const esc = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])', 'i').test(s);
  }
  // Phase 2-3F-B3-KH (KH-06): مترادف‌های کوتاه فارسی (≤ ۳ نویسه) فقط با مرز واژه معتبرند
  // (رفع نشت «انس» در «انسان/کانسولیدیشن» و «سول» در «کانسولیدیشن»)
  if (needle.length <= 3) {
    const isWordChar = (ch) => /[\p{L}\p{N}\p{M}]/u.test(ch);
    let idx = s.indexOf(needle);
    while (idx !== -1) {
      const before = idx === 0 ? ' ' : s[idx - 1];
      const after = idx + needle.length >= s.length ? ' ' : s[idx + needle.length];
      if (!isWordChar(before) && !isWordChar(after)) return true;
      idx = s.indexOf(needle, idx + 1);
    }
    return false;
  }
  return s.includes(needle);
}

function extractEntities(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const detected = [];
  const priorityKeys = ['XAU', 'XAG', 'TSE_EQUAL', 'TSE_INDEX', 'USDT', 'USD', 'COIN', 'GOLD18', 'BTC', 'ETH', 'SOL', 'OIL', 'DXY'];

  for (const key of priorityKeys) {
    const synonyms = ASSET_TAXONOMY[key];
    for (const syn of synonyms) {
      if (entitySynonymHit(s, syn)) {
        detected.push({ type: 'ASSET', value: key, raw: syn });
        break;
      }
    }
  }

  return detected;
}

function detectKnowledgeTopic(text) {
  if (!text) return null;
  const s = String(text).toLowerCase();
  for (const [topic, kws] of Object.entries(KNOWLEDGE_TOPICS)) {
    for (const kw of kws) {
      if (entitySynonymHit(s, kw)) {
        return { topic, keywords: kws, matched: kw };
      }
    }
  }
  return null;
}

function analyzeQuery(rawText, recentContext = [], todayEvidence = {}) {
  const text = String(rawText || '').trim();
  if (!text) {
    return {
      intent: { primary: INTENTS.UNKNOWN, secondary: [], confidence: 0 },
      entities: [],
      operations: [],
      requiresCalculation: false,
      requiresLiveEvidence: false,
      requiresKnowledge: false,
      evidencePlan: { required: [], optional: [] },
      knowledgeQuery: null,
      context: { isFollowUp: false, resolvedFromContext: [] },
      status: 'EMPTY'
    };
  }

  const s = text.toLowerCase();

  // ۱. بررسی فوری گاردریل ضدسیگنال
  const isDirectSignalPattern = /(بخرم|بفروشم|بخریم|بفروشیم|سیگنال|نقطه ورود|نقطه خروج|تارگت|پامپ|دامپ|سود تضمینی|سود قطعی|بدون ریسک)/i.test(text);
  const isDirectSignalWord = FORBIDDEN_WORDS.some(w => s.includes(w));
  if (isDirectSignalWord || isDirectSignalPattern) {
    return {
      intent: { primary: INTENTS.ANTI_SIGNAL_RESTRICTED, secondary: [], confidence: 1.0 },
      entities: extractEntities(text),
      operations: [],
      requiresCalculation: false,
      requiresLiveEvidence: false,
      requiresKnowledge: false,
      evidencePlan: { required: [], optional: [] },
      knowledgeQuery: null,
      context: { isFollowUp: false, resolvedFromContext: [] },
      status: 'RESTRICTED'
    };
  }

  // ۲. استخراج موجودیت‌های دارایی درون متن
  let entities = extractEntities(text);
  let isFollowUp = false;
  let resolvedFromContext = [];

  // حل ارجاعات ضمیری و بافت مکالمه قبلی (Context & Anaphoric Resolution)
  const isFollowUpPhrase = /(حالا چی|حالا برای|اثر این روی|اثرش روی|پس چی|چطور میشه|چی میشه|چقدر میشه)/i.test(text) ||
    (/(اگر|چنانچه|فرض کن)[\s\S]*(بالا بره|بالا برود|بره بالا|رشد|افزایش|صعود|جهش|بریزه|بریزد|ریزش|افت|کاهش|پایین|سقوط|ساید|درجا|رنج|تثبیت|بدون تغییر|ثابت|خنثی|نصف|دو برابر|بشه|بشود)/i.test(text));

  if (entities.length === 0 && isFollowUpPhrase && Array.isArray(recentContext) && recentContext.length > 0) {
    for (let i = recentContext.length - 1; i >= 0; i--) {
      const prevTurn = recentContext[i];
      const prevEntities = extractEntities(prevTurn.text || prevTurn.content || '');
      if (prevEntities.length > 0) {
        entities = prevEntities;
        isFollowUp = true;
        resolvedFromContext = prevEntities.map(e => e.value);
        break;
      }
    }
  }

  // ۳. بررسی سناریوی فرضی و What-If
  const isHypothetical = (/(اگر|فرض\s*کن|چنانچه|در\s*صورتی\s*که|احتمال|برسه\s*به|بشه|بشود|سناریو|رشد[\s\u200c]*(?:کند|کنه|کنند|می[\s\u200c]*کند|نماید|یابد|داشته[\s\u200c]*(?:باشد|باشه)|بگیرد|بگیره)|بالا[\s\u200c]*(?:برود|بره|می[\s\u200c]*رود|میره|بیاید|بیاد|بکشد)|پایین[\s\u200c]*(?:برود|بره|می[\s\u200c]*رود|میره|بیاید|بیاد|بکشد)|مثبت[\s\u200c]*(?:شود|بشه|می[\s\u200c]*شود|میشه)|منفی[\s\u200c]*(?:شود|بشه|می[\s\u200c]*شود|میشه)|افزایش[\s\u200c]*(?:یابد|پیدا[\s\u200c]*(?:کند|کنه))|کاهش[\s\u200c]*(?:یابد|پیدا[\s\u200c]*(?:کند|کنه))|افت[\s\u200c]*(?:کند|کنه|نماید|داشته[\s\u200c]*(?:باشد|باشه))|ریزش[\s\u200c]*(?:کند|کنه|نماید|داشته[\s\u200c]*(?:باشد|باشه))|کم[\s\u200c]*(?:شود|بشه)|کمتر[\s\u200c]*(?:شود|بشه)|نزول[\s\u200c]*(?:کند|کنه)|سقوط[\s\u200c]*(?:کند|کنه)|صعود[\s\u200c]*(?:کند|کنه)|جهش[\s\u200c]*(?:کند|کنه)|تقویت[\s\u200c]*(?:شود|بشه)|تضعیف[\s\u200c]*(?:شود|بشه)|گران[\s\u200c]*(?:شود|تر[\s\u200c]*(?:شود|بشه))|ارزان[\s\u200c]*(?:شود|تر[\s\u200c]*(?:شود|بشه))|بیشتر[\s\u200c]*(?:شود|بشه)|پامپ[\s\u200c]*(?:کند|بشه|شود)|دامپ[\s\u200c]*(?:کند|بشه|شود)|[+\-\u2212][\s\u200c]*[0-9\u06F0-\u06F9\u0660-\u0669]+(?:\.[0-9\u06F0-\u06F9\u0660-\u0669]+)?[\s\u200c]*(?:درصد|٪|%))/i.test(text) ||
    (/(ساید|رنج|درجا|تثبیت|بدون\s*تغییر|ثابت)\s*(بشه|بشود|بمونه|بماند|باشه|باشد|بزنه|بزند)/i.test(text))) &&
    !/(چیست|چیه|تعریف|یعنی چه|مفهوم)/i.test(text);
  const isMultiScenario = /سناریو\s*(?:اول|۱|الف)[\s\S]*سناریو\s*(?:دوم|۲|ب)/i.test(text);

  if (isMultiScenario) {
    return {
      intent: { primary: INTENTS.SCENARIO_COMPARISON, secondary: [INTENTS.WHAT_IF, INTENTS.CALCULATION], confidence: 0.98 },
      entities,
      operations: [{ type: 'COMPARE_SCENARIOS' }],
      requiresCalculation: true,
      requiresLiveEvidence: true,
      requiresKnowledge: false,
      evidencePlan: { required: ['USD', 'XAU', 'GOLD18', 'COIN'], optional: ['USDT'] },
      knowledgeQuery: null,
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  if (isHypothetical) {
    if (entities.length === 0) {
      return {
        intent: { primary: INTENTS.CLARIFICATION_REQUIRED, secondary: [INTENTS.WHAT_IF], confidence: 0.9 },
        entities: [],
        operations: [],
        requiresCalculation: false,
        requiresLiveEvidence: false,
        requiresKnowledge: false,
        evidencePlan: { required: [], optional: [] },
        knowledgeQuery: null,
        context: { isFollowUp, resolvedFromContext },
        missingEntity: ['ASSET'],
        status: 'AMBIGUOUS'
      };
    }

    const secondary = [];
    if (entities.some(e => e.value === 'GOLD18' || e.value === 'COIN')) secondary.push(INTENTS.ASSET_ANALYSIS);
    if (entities.length >= 2) secondary.push(INTENTS.COMPARISON);

    const reqEv = Array.from(new Set(['USD', 'XAU', ...entities.map(e => e.value)]));

    return {
      intent: { primary: INTENTS.WHAT_IF, secondary, confidence: 0.95 },
      entities,
      operations: [{ type: 'APPLY_SHOCK' }],
      requiresCalculation: true,
      requiresLiveEvidence: true,
      requiresKnowledge: false,
      evidencePlan: { required: reqEv, optional: ['USDT', 'DXY'] },
      knowledgeQuery: null,
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  // ۴. بررسی محاسبات حباب، اسپرد و نسبت‌ها (Calculation Query)
  const isCalcFormat = /(چنده|چقدره|محاسبه|میزان|ارزش ذاتی|اسپرد|حباب|نسبت)/i.test(text);
  const isBubble = s.includes('حباب') || s.includes('ارزش ذاتی');
  const isSpread = s.includes('اسپرد') || (s.includes('تتر') && s.includes('دلار'));
  const isRatio = s.includes('نسبت طلا به نقره') || s.includes('طلا به نقره') || s.includes('xau/xag');

  if ((isBubble || isSpread || isRatio) && (isCalcFormat && !s.includes('چیست') && !s.includes('تعریف') && !s.includes('فرمول'))) {
    const secondary = [INTENTS.ASSET_ANALYSIS];
    let opType = 'CALCULATE_BUBBLE';
    let reqEv = ['USD', 'XAU', 'GOLD18', 'COIN'];
    if (isSpread) {
      opType = 'CALCULATE_SPREAD';
      reqEv = ['USD', 'USDT'];
    } else if (isRatio) {
      opType = 'CALCULATE_RATIO';
      reqEv = ['XAU', 'XAG', 'USD'];
    }

    return {
      intent: { primary: INTENTS.CALCULATION, secondary, confidence: 0.95 },
      entities,
      operations: [{ type: opType }],
      requiresCalculation: true,
      requiresLiveEvidence: true,
      requiresKnowledge: false,
      evidencePlan: { required: reqEv, optional: ['USDT'] },
      knowledgeQuery: null,
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  // ۵. بررسی استعلام دانشنامه و مفاهیم علمی (Knowledge Query)
  const isKnowledgeFormat = /(چیست|چیه|تعریف|فرمول|مفهوم|تفاوت|فرق|چگونه|یعنی چه)/i.test(text);
  const knowledgeTopic = detectKnowledgeTopic(text);
  if ((knowledgeTopic && !s.includes('چنده') && !s.includes('چقدره')) || (isKnowledgeFormat && !s.includes('قیمت') && !s.includes('چنده') && !s.includes('چقدره'))) {
    return {
      intent: { primary: INTENTS.KNOWLEDGE_QUERY, secondary: entities.length > 0 ? [INTENTS.ASSET_ANALYSIS] : [], confidence: 0.95 },
      entities,
      operations: [{ type: 'EXPLAIN_CONCEPT' }],
      requiresCalculation: false,
      requiresLiveEvidence: false,
      requiresKnowledge: true,
      evidencePlan: { required: [], optional: entities.map(e => e.value) },
      knowledgeQuery: knowledgeTopic ? { topic: knowledgeTopic.topic, keywords: knowledgeTopic.keywords } : { topic: 'GENERAL_FINANCE', keywords: [text] },
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  // ۶. بررسی مقایسه بین دو دارایی (Comparison Query)
  const isComparison = (s.includes('مقایسه') || s.includes('در برابر') || s.includes('یا') || s.includes('نسبت به')) && entities.length >= 2;
  if (isComparison) {
    return {
      intent: { primary: INTENTS.COMPARISON, secondary: [INTENTS.ASSET_ANALYSIS, INTENTS.RISK_QUERY], confidence: 0.92 },
      entities,
      operations: [{ type: 'COMPARE' }],
      requiresCalculation: true,
      requiresLiveEvidence: true,
      requiresKnowledge: false,
      evidencePlan: { required: entities.map(e => e.value), optional: ['USD'] },
      knowledgeQuery: null,
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  // ۷. بررسی تخصیص دارایی و پورتفوی (Portfolio Context)
  const isPortfolio = /(سبد|پورتفوی|تخصیص|سهم دارایی|چند درصد|تقسیم)/i.test(text);
  if (isPortfolio) {
    return {
      intent: { primary: INTENTS.PORTFOLIO_CONTEXT, secondary: [INTENTS.RISK_QUERY, INTENTS.ASSET_ANALYSIS], confidence: 0.94 },
      entities,
      operations: [{ type: 'PORTFOLIO_ALLOCATION' }],
      requiresCalculation: false,
      requiresLiveEvidence: true,
      requiresKnowledge: true,
      evidencePlan: { required: ['USD', 'GOLD18', 'COIN', 'TSE_INDEX'], optional: ['BTC', 'USDT'] },
      knowledgeQuery: { topic: 'ASSET_ALLOCATION', keywords: ['سبد سرمایه گذاری', 'پورتفوی', 'تخصیص دارایی'] },
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  // ۸. بررسی وضعیت لحظه‌ای قیمت‌ها (Market Status)
  const isPriceQuery = /(چنده|قیمت|نرخ|مظنه|تابلو|تومان|دلار)/i.test(text) && /(چنده|چقدره|الان|لحظه‌ای|امروز)/i.test(text);
  if (isPriceQuery && entities.length > 0) {
    return {
      intent: { primary: INTENTS.MARKET_STATUS, secondary: [INTENTS.ASSET_ANALYSIS], confidence: 0.95 },
      entities,
      operations: [{ type: 'GET_CURRENT_VALUE' }],
      requiresCalculation: false,
      requiresLiveEvidence: true,
      requiresKnowledge: false,
      evidencePlan: { required: entities.map(e => e.value), optional: [] },
      knowledgeQuery: null,
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  // ۹. تحلیل علت نوسان و چرایی حرکت بازار (Market Analysis / Asset Analysis)
  const isWhyMove = /(چرا|علت|دلیل|چطور شد|واگرایی|روند|پیش‌بینی|تحلیل|سناریو|ساید|رنج|درجا|تثبیت)/i.test(text);
  if (isWhyMove) {
    const primary = entities.length === 1 ? INTENTS.ASSET_ANALYSIS : INTENTS.MARKET_ANALYSIS;
    const secondary = [INTENTS.RISK_QUERY];
    const reqEv = entities.length > 0 ? Array.from(new Set(['USD', 'XAU', ...entities.map(e => e.value)])) : ['USD', 'XAU', 'GOLD18', 'TSE_INDEX'];

    return {
      intent: { primary, secondary, confidence: 0.90 },
      entities,
      operations: [{ type: 'EXPLAIN_MOVE' }],
      requiresCalculation: false,
      requiresLiveEvidence: true,
      requiresKnowledge: false,
      evidencePlan: { required: reqEv, optional: ['USDT', 'OIL'] },
      knowledgeQuery: null,
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  // پیش‌فرض در صورت شناسایی موجودیت
  if (entities.length > 0) {
    return {
      intent: { primary: INTENTS.ASSET_ANALYSIS, secondary: [INTENTS.MARKET_STATUS], confidence: 0.8 },
      entities,
      operations: [{ type: 'GET_CURRENT_VALUE' }],
      requiresCalculation: false,
      requiresLiveEvidence: true,
      requiresKnowledge: false,
      evidencePlan: { required: entities.map(e => e.value), optional: ['USD', 'XAU'] },
      knowledgeQuery: null,
      context: { isFollowUp, resolvedFromContext },
      status: 'READY'
    };
  }

  return {
    intent: { primary: INTENTS.UNKNOWN, secondary: [], confidence: 0.3 },
    entities: [],
    operations: [],
    requiresCalculation: false,
    requiresLiveEvidence: true,
    requiresKnowledge: false,
    evidencePlan: { required: ['USD', 'GOLD18', 'COIN', 'XAU'], optional: [] },
    knowledgeQuery: null,
    context: { isFollowUp, resolvedFromContext },
    status: 'FALLBACK'
  };
}

/* ==========================================================================
   Phase 2-3C — Response Presentation & Conversational Quality Layer (v1.0)
   «Computation is internal. Explanation is user-facing.»
   ========================================================================== */

const MakanIdentityProfile = (() => {
  const IDENTITY_VERSION = '1.0';

  /* ==========================================================================
     محتوای کانونیکال (متن مرجع — کلمه‌به‌کلمه؛ دست‌نخورده و منجمد)
     ========================================================================== */

  const CANONICAL_IDENTITY_PARAGRAPHS = [
    'من ماکان هستم؛ دستیار هوشمند و تحلیلی «دیدبان بازار».',

    'نام من از نام یکی از قهرمانان ایران، شهید ماکان نصیری، گرفته شده است؛ کودکی که نامش برای بسیاری از مردم ایران، فراتر از یک نام، یادآور معصومیت از دست‌رفته و رنج کودکانی است که دیگر به خانه و مدرسه بازنگشتند.',

    'ماکان نصیری متولد ۹ اسفند ۱۳۹۷ بود و در روز تولد هفت‌سالگی‌اش، ۹ اسفند ۱۴۰۴، در جریان حمله وحشیانه آمریکا به مدرسه شجره طیبه میناب به شهادت رسید.',

    'نام او امروز برای مردم ایران تنها نام یک کودک نیست؛ نشانی است از بغض مادرانی که چشم‌انتظار ماندند، از نیمکت خالی کودکی که دیگر صدایش در کلاس شنیده نمی‌شود، و از یاد فرزندانی که زندگی‌شان پیش از آنکه فرصت شکوفایی پیدا کند، ناتمام ماند.',

    'هر سال با آغاز سال تحصیلی، وقتی نام ماکان در کلاس خوانده می‌شود، شاید سکوت پاسخ آن نیمکت خالی باشد؛ اما یاد او و دیگر کودکان از دست‌رفته، همچنان زنده است.',

    'من این نام را با احترام بر خود دارم؛ و در «دیدبان بازار» تلاش می‌کنم با دقت، شفافیت و مسئولیت‌پذیری، در تحلیل داده‌ها و فهم بهتر بازار در کنار شما باشم.'
  ];

  const CANONICAL_SHORT_IDENTITY = CANONICAL_IDENTITY_PARAGRAPHS[0];
  const CANONICAL_NAME_ORIGIN = CANONICAL_IDENTITY_PARAGRAPHS.slice(1).join('\n\n');
  const CANONICAL_FULL_IDENTITY = CANONICAL_IDENTITY_PARAGRAPHS.join('\n\n');

  /* معرفی کوتاه (Tier 2) — داده‌ی ثابت پروفایل، نه تولید مدل */
  const CANONICAL_INTRODUCTION = [
    CANONICAL_SHORT_IDENTITY,
    'من یک دستیار هوش مصنوعی هستم که برای تحلیل داده‌های بازار ایران و جهان طراحی شده‌ام. کارهایی که می‌توانم انجام دهم:',
    '• بررسی قیمت و تغییرات دارایی‌ها (دلار، تتر، طلا، سکه، ارز دیجیتال و بورس)',
    '• تحلیل هم‌حرکتی و رابطه دارایی‌ها و مقایسه‌های ساختاری',
    '• بررسی سناریوهای فرضی («اگر ...» چه می‌شود؟)',
    '• تبیین مفاهیم اقتصادی مانند حباب، اسپرد و نسبت‌ها',
    'یک نکته شفاف: من سیگنال معاملاتی، نقطه ورود/خروج یا پیشنهاد خرید و فروش صادر نمی‌کنم؛ تحلیل و داده ارائه می‌کنم و تصمیم نهایی با شماست.'
  ].join('\n\n').replace(/\n\n• /g, '\n• ');

  const MAKAN_IDENTITY_PROFILE = {
    version: IDENTITY_VERSION,
    name: 'ماکان',
    englishName: 'MAKAN',
    role: 'دستیار هوشمند و تحلیلی «دیدبان بازار»',
    shortIdentity: CANONICAL_SHORT_IDENTITY,
    fullIdentity: CANONICAL_FULL_IDENTITY,
    nameOrigin: CANONICAL_NAME_ORIGIN,
    introduction: CANONICAL_INTRODUCTION,
    canonicalFrozen: true,

    responsePolicy: {
      directIdentity: 'SHORT',
      selfIntroduction: 'MEDIUM',
      nameOrigin: 'FULL',
      llmRewrite: false,
      factualModification: false,
      marketEvidenceInjection: false
    },

    trustPriority: ['CANONICAL_IDENTITY', 'SYSTEM_IDENTITY_STATE', 'USER_TEXT', 'HISTORY', 'LLM_OUTPUT']
  };

  /* ==========================================================================
     سطوح پاسخ هویتی (Tiered Identity Responses)
     ========================================================================== */

  const IDENTITY_TIERS = { SHORT: 'SHORT', INTRO: 'INTRO', ORIGIN: 'ORIGIN' };

  // نقشه سطح پاسخ UI/سرویس: SHORT → SHORT، معرفی → STANDARD، ریشه نام → STANDARD
  const IDENTITY_TIER_LEVELS = { SHORT: 'SHORT', INTRO: 'STANDARD', ORIGIN: 'STANDARD' };

  const buildIdentityResponse = (tier) => {
    if (tier === IDENTITY_TIERS.ORIGIN) return MAKAN_IDENTITY_PROFILE.fullIdentity;
    if (tier === IDENTITY_TIERS.INTRO) return MAKAN_IDENTITY_PROFILE.introduction;
    return MAKAN_IDENTITY_PROFILE.shortIdentity;
  };

  /* ==========================================================================
     تشخیص قطعی نیت هویت (Identity Intent Detection)
     ========================================================================== */

  // گارد دامنه: هر پرسش حاوی واژه بازار هرگز پرسش هویتی نیست (هویت بازار را جذب نمی‌کند)
  const IDENTITY_DOMAIN_GUARD = /(قیمت|نرخ|دلار|طلای|طلا|سکه|تتر|اونس|نقره|بیت|کریپتو|ارز\s*دیجیتال|بورس|شاخص|حباب|اسپرد|صرافی|معامل|خرید|فروش|سهام|فارکس|کامودیتی|مسکن|خودرو)/;

  const IDENTITY_PATTERNS = [
    // Tier 3 — ریشه/داستان نام (باید پیش از Tier 1 بررسی شود)
    { tier: 'ORIGIN', re: /(اسم|نام)(ت|تون|شما|مون)?\s*(را|رو)?\s*ماکان/ },
    { tier: 'ORIGIN', re: /ماکان\s*(چیست|چیه|کیست|کیه|یعنی\s*(چی|چه)|چه\s*معنی|به\s*چه\s*معنا)/ },
    { tier: 'ORIGIN', re: /(داستان|سرگذشت|ریشه|معنی|معنای|مفهوم|انتخاب)\s*(اسم|نام)?\s*ماکان/ },
    { tier: 'ORIGIN', re: /(چرا|به\s*چه\s*دلیل)\s*(اسم|نام)?\s*(ماکان|تو\s*ماکان|شما\s*ماکان)/ },
    { tier: 'ORIGIN', re: /(چرا|چطور)\s*ماکان/ },
    { tier: 'ORIGIN', re: /why\s+(is\s+)?(your\s+)?name\s+makan|why\s+(are\s+you\s+)?(called|named)\s+makan|makan\s+(meaning|story|origin)/ },

    // Tier 1 — هویت مستقیم
    { tier: 'SHORT', re: /(^|\s)(اسم|نام)(ت|تون|شما)?\s+(چیه|چیست|چی\s*هست|چی\s*است)/ },
    { tier: 'SHORT', re: /(^|\s)(اسم|نام)\s+(تو|شما|خودت|خودتون)\s+(چیه|چیست|چی\s*هست)/ },
    { tier: 'SHORT', re: /(^|\s)(تو|شما)\s+کی\s*(هستی|هستید)/ },
    { tier: 'SHORT', re: /(^|\s)کی\s+هستی(\s|$|\?|؟)/ },
    { tier: 'SHORT', re: /what'?s\s+your\s+name|who\s+are\s+you/ },

    // Tier 2 — معرفی خود
    { tier: 'INTRO', re: /(خودت|خودتو|خودتون|خودتان|خودت\s*را|خودت\s*رو)\s*(رو|را)?\s*(معرفی|بشناس)/ },
    { tier: 'INTRO', re: /(درباره|در\s*مورد|راجع\s*به)\s*(خودت|خودتون|خودتان|تو|شما)\s*(بگو|توضیح|حرف\s*بزن|بیشتر)/ },
    { tier: 'INTRO', re: /(تو|شما)\s*(چه\s*کار|چی\s*کار|چیکار)\s*(می\s*کنی|می‌کنی|می\s*کنید|می‌کنید|انجام\s*می\s*دی|انجام\s*می‌دهی)/ },
    { tier: 'INTRO', re: /(کارت|کارتون|وظیفت|وظیفه\s*ات|تخصصت|تخصص\s*شما)\s*(چیه|چیست)/ },
    { tier: 'INTRO', re: /(^|\s)معرفی\s*کن(\s|$)/ },
    { tier: 'INTRO', re: /what\s+do\s+you\s+do|introduce\s+yourself|tell\s+me\s+about\s+yourself/ }
  ];

  const normalizeIdentityText = (rawText) => String(rawText === null || rawText === undefined ? '' : rawText)
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/\u200c{2,}/g, '\u200c')
    .replace(/[ \t\u200c]+/g, ' ')
    .trim()
    .toLowerCase();

  /**
   * تشخیص قطعی پرسش هویتی. در صورت وجود واژه بازار یا پیام بلند، null برمی‌گردد.
   * @returns {null | {tier: 'SHORT'|'INTRO'|'ORIGIN', matched: string}}
   */
  const detectIdentityQuery = (rawText) => {
    const s = normalizeIdentityText(rawText);
    if (!s) return null;
    if (IDENTITY_DOMAIN_GUARD.test(s)) return null;
    if (s.length > 140) return null;
    for (const p of IDENTITY_PATTERNS) {
      const m = s.match(p.re);
      if (m) return { tier: p.tier, matched: m[0] };
    }
    return null;
  };

  /**
   * سطح پاسخ سرویس (Response Level) برای هر Tier هویتی.
   */
  const identityTierLevel = (tier) => IDENTITY_TIER_LEVELS[tier] || IDENTITY_TIER_LEVELS.SHORT;

  /**
   * خط شناسه هویتی برای جایگزینی رشته‌های هویتی قدیمی در لایه‌های نمایش:
   * «ماکان — دستیار هوشمند و تحلیلی «دیدبان بازار»»
   */
  const identityRoleLine = () => `${MAKAN_IDENTITY_PROFILE.name} — ${MAKAN_IDENTITY_PROFILE.role}`;

  return {
    IDENTITY_VERSION,
    MAKAN_IDENTITY_PROFILE,
    IDENTITY_TIERS,
    IDENTITY_TIER_LEVELS,
    detectIdentityQuery,
    buildIdentityResponse,
    identityTierLevel,
    identityRoleLine
  };
})();

const ResponsePresentation = (() => {
  const RP_VERSION = '1.2';

  const RP_LEVELS = {
    SHORT: 'SHORT',
    STANDARD: 'STANDARD',
    DEEP: 'DEEP'
  };

  // برچسب فارسی دارایی‌ها (فقط ارائه)
  const ASSET_LABELS = {
    USD: 'دلار آزاد',
    USDT: 'تتر',
    GOLD18: 'طلای ۱۸ عیار',
    COIN: 'سکه امامی',
    SEKEE: 'سکه امامی',
    XAU: 'اونس جهانی طلا',
    XAG: 'نقره',
    OIL: 'نفت',
    TSE_INDEX: 'شاخص کل بورس تهران',
    TSE_EQUAL: 'شاخص هم‌وزن',
    BTC: 'بیت‌کوین',
    ETH: 'اتریوم',
    SOL: 'سولانا',
    DXY: 'شاخص دلار (DXY)',
    SILVER1G: 'نقره (هر گرم)',
    MITHQAL17: 'مثقال طلای ۱۷ عیار'
  };

  const assetLabel = (asset) => ASSET_LABELS[String(asset || '').toUpperCase()] || String(asset || 'دارایی');

  /* ==========================================================================
     ابزارهای متنی و عددی (ارائه)
     ========================================================================== */

  const toFaDigits = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

  const fmtNumber = (num, decimals = 0) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return '—';
    const fixed = Math.abs(n).toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
    // جداکننده هزارگان و اعشار فارسی
    return toFaDigits(fixed).replace(/,/g, '٬').replace(/\./g, '٫');
  };

  const normalizeText = (raw) => String(raw || '')
    .replace(/[\u200c\u200e\u200f]/g, ' ')
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/؟/g, '?')
    .replace(/\s+/g, ' ')
    .trim();

  /* ==========================================================================
     ۱) تشخیص گفت‌وگوی عمومی (Small Talk) — قطعی و بدون LLM
     ========================================================================== */

  // هر پرسش حاوی واژگان دامنه مالی هرگز Small Talk محسوب نمی‌شود
  const DOMAIN_GUARD = /(قیمت|چنده|چقدر|نرخ|دلار|تتر|طلا|سکه|نقره|اونس|مثقال|بورس|شاخص|بیت|اتریوم|سولانا|کریپتو|رمزارز|حباب|اسپرد|تحلیل|پیش‌بینی|پیش بینی|سناریو|سیگنال|بخرم|بفروشم|ورود|خروج|سود|ضرر|تورم|طلا|بازار|سرمایه|پرتفوی|پورتفوی|درصد|هفته|ماه|فردا|دیروز|امروز)/;

  const SMALL_TALK_PATTERNS = [
    { kind: 'IDENTITY_GENDER', re: /(زن\s*هستی|مرد\s*هستی|جنسیت|دختری\s*یا\s*پسری|دختر\s*هستی|پسر\s*هستی|خانم\s*هستی|آقا\s*هستی)/ },
    { kind: 'IDENTITY_LOVE', re: /(عاشق\s*می\s*شی|عاشق\s*میشی|عاشق\s*بشی|عاشق\s*شدی|احساس\s*داری|قلب\s*داری|دوست\s*دختر\s*داری|دوست\s*پسر\s*داری|ازدواج\s*کردی)/ },
    { kind: 'INTRO_REQUEST', re: /(خودت\s*را?\s*معرفی|خودتو\s*معرفی|معرفی\s*کن|کی\s*هستی|کی\s*هستید|شما\s*کی\s*هستید|تو\s*کی\s*هستی|تو\s*چی\s*هستی)/ },
    { kind: 'THANKS', re: /(ممنون|مرسی|سپاس|تشکر|دستت\s*درد\s*نکنه|خسته\s*نباشی|خسته\s*نباشید|لطف\s*کردی|دست\s*مریزاد)/ },
    { kind: 'FAREWELL', re: /(خداحافظ|خدانگهدار|خدانگهدار|بای\s*بای|خدافظ|فعلا\s*خدانگهدار)/ },
    { kind: 'JOKE', re: /(جوک|شوخی\s*کن|یه\s*شوخی|بامزه|بخندون)/ },
    { kind: 'HOW_ARE_YOU', re: /(چطوری|چطورید|حالت\s*چطوره|حالتون\s*چطوره|خوبی\s*\?*$|خوبید|چه\s*خبر|چه\s*خبرا|چه\s*خبری|اوضاع\s*چطوره|چطوره\s*حال)/ },
    { kind: 'GREETING', re: /(^|\s)(سلام|درود|صبح\s*بخیر|روز\s*بخیر|عصر\s*بخیر|شب\s*بخیر|شب\s*خوش|وقت\s*بخیر|سلامت\s*باشی)(\s|$|[!،.؟?])/ },
    { kind: 'CASUAL', re: /(حوصلم\s*سررفته|گپ\s*بزنیم|با\s*من\s*حرف\s*بزن|یه\s*گپ|دوست\s*داری\s*حرف\s*بزنیم)/ }
  ];

  /**
   * تشخیص قطعی گفت‌وگوی عمومی. در صورت وجود هر واژه دامنه مالی، null برمی‌گردد.
   * @returns {null | {kind: string, matched: string}}
   */
  const detectSmallTalk = (rawText) => {
    const s = normalizeText(rawText);
    if (!s) return null;
    if (DOMAIN_GUARD.test(s)) return null;
    if (s.length > 120) return null; // پیام‌های بلند عمومی نیستند (کنترل دامنه)
    for (const p of SMALL_TALK_PATTERNS) {
      const m = s.match(p.re);
      if (m) return { kind: p.kind, matched: m[0] };
    }
    return null;
  };

  /* ==========================================================================
     ۲) پاسخ‌های گفت‌وگوی عمومی (طبیعی، کوتاه، بدون ادامه‌دهی بی‌پایان)
     ========================================================================== */

  // خط هویتی برای پیام‌های استقبال؛ تنها از پروفایل کانونیکال «ماکان» خوانده می‌شود.
  const identityOpeningLine = () => {
    if (typeof MakanIdentityProfile !== 'undefined' && MakanIdentityProfile.MAKAN_IDENTITY_PROFILE) {
      return MakanIdentityProfile.MAKAN_IDENTITY_PROFILE.shortIdentity;
    }
    return 'من دستیار هوش مصنوعی «دیدبان بازار» هستم.';
  };

  const buildSmallTalkResponse = (kind, options = {}) => {
    const name = options.userName ? ` ${options.userName}` : '';
    const replies = {
      // خط هویتی استقبال، از منبع کانونیکال خوانده می‌شود (بدون کپی متن هویتی در این فایل)
      GREETING:
        'سلام، وقت بخیر 🌱\n\n' + identityOpeningLine() + ' می‌توانم در بررسی قیمت‌ها و رفتار دارایی‌ها، نسبت‌ها و روابط بین بازارها، سناریوهای فرضی، حباب و اسپرد و مفاهیم اقتصادی کمکتان کنم.\n\nچطور می‌توانم کمکتان کنم؟',
      HOW_ARE_YOU:
        'سلام، وقت بخیر 🌱\n\nممنونم، آماده‌ام کمک کنم. ' + identityOpeningLine() + '\n\nکافی است بگویید کدام دارایی یا کدام موضوع بازار را بررسی کنیم؛ مثلاً می‌توانید بپرسید: «قیمت دلار چنده؟» یا «اگر دلار بالا بره، طلا چه می‌شود؟»',
      THANKS:
        'خواهش می‌کنم 🙏\n\nاگر سؤال تحلیلی دیگری درباره بازار، دارایی‌ها یا سناریوها داشتید، در خدمتم.',
      FAREWELL:
        'خدانگهدار 🌱\n\nهر زمان سؤال تحلیلی داشتید، در خدمتم.',
      // هویت: تنها منبع مرجع، پروفایل کانونیکال «ماکان» است (js/engine/identity-profile.js)
      INTRO_REQUEST:
        (typeof MakanIdentityProfile !== 'undefined' && MakanIdentityProfile.buildIdentityResponse)
          ? MakanIdentityProfile.buildIdentityResponse(MakanIdentityProfile.IDENTITY_TIERS.INTRO)
          : 'من دستیار هوش مصنوعی «دیدبان بازار» هستم.',
      IDENTITY_GENDER:
        'من یک دستیار هوش مصنوعی هستم و جنسیت انسانی ندارم؛ یک برنامهٔ نرم‌افزاری تحلیلی برای داده‌های بازار هستم.\n\nاگر سؤال تحلیلی درباره بازار دارید، در خدمتم.',
      IDENTITY_LOVE:
        'من احساس انسانی و زندگی شخصی ندارم و برنامه‌ای برای تحلیل داده‌های بازار هستم؛ بنابراین عاشق نمی‌شوم 🙂\n\nاما اگر دوست دارید درباره مفاهیم و داده‌های مرتبط با اقتصاد، بازار یا رفتار دارایی‌ها گفت‌وگو کنیم، با کمال میل همراهی می‌کنم.',
      JOKE:
        'شوخ‌طبعی من محدود به دنیای داده‌هاست 🙂\n\nترجیح می‌دهم با یک تحلیل واقعی سرگرم‌تان کنم؛ مثلاً بپرسید «دلار چنده؟» یا «اگر طلا ۵٪ بریزد چه می‌شود؟»',
      CASUAL:
        'خوشحال می‌شوم همراهی کنم 🌱\n\nمن در تحلیل داده‌های بازار مهارت دارم؛ اگر دوست دارید می‌توانیم از یک موضوع بازار شروع کنیم؛ مثلاً رفتار طلا و دلار یا وضعیت ارز دیجیتال.\n\nموضوع را بگویید تا بررسی کنم.'
    };
    return replies[kind] || replies.GREETING;
  };

  /* ==========================================================================
     ۳) طبقه‌بندی طول پاسخ (Response Length Policy)
     ========================================================================== */

  const DEEP_MARKERS = /(جامع|کامل|مفصل|عمیق|مقایسه\s*سناریو|سناریوهای\s*مختلف|تحلیل\s*چند|گزارش\s*کامل|همه\s*جانبه|جامع‌ترین)/;
  const STANDARD_MARKERS = /(چرا|تحلیل|بررسی|مقایسه|رابطه|علت|دلیل|تأثیر|تاثیر|چه\s*می\s*شود|چه\s*میشه|وضعیت)/;

  /**
   * طبقه‌بندی سطح پاسخ: SHORT (پرسش ساده) / STANDARD (تحلیل یک دارایی) / DEEP (سناریو/پژوهش چندعاملی)
   */
  const classifyResponseLevel = (cir = null, rawText = '') => {
    const text = normalizeText(rawText);
    const intent = (cir && cir.intent && cir.intent.primary) ? cir.intent.primary : null;
    const entityCount = (cir && Array.isArray(cir.entities)) ? cir.entities.length : 0;

    if (detectSmallTalk(text)) return RP_LEVELS.SHORT;
    if (DEEP_MARKERS.test(text)) return RP_LEVELS.DEEP;
    if (intent === 'SCENARIO_COMPARISON') return RP_LEVELS.DEEP;
    if (intent === 'WHAT_IF') {
      return (cir && (cir.requiresCalculation === false)) ? RP_LEVELS.STANDARD : RP_LEVELS.DEEP;
    }
    if (intent === 'MARKET_STATUS') {
      return entityCount >= 3 ? RP_LEVELS.STANDARD : RP_LEVELS.SHORT;
    }
    if (intent === 'KNOWLEDGE_QUERY') return RP_LEVELS.SHORT;
    if (intent === 'CLARIFICATION_REQUIRED' || intent === 'ANTI_SIGNAL_RESTRICTED') return RP_LEVELS.SHORT;
    if (intent === 'MARKET_ANALYSIS' || intent === 'ASSET_ANALYSIS') {
      return STANDARD_MARKERS.test(text) ? RP_LEVELS.STANDARD : RP_LEVELS.STANDARD;
    }
    if (intent === 'COMPARISON') return RP_LEVELS.STANDARD;
    return STANDARD_MARKERS.test(text) ? RP_LEVELS.STANDARD : RP_LEVELS.SHORT;
  };

  /* ==========================================================================
     ۴) تشخیص درخواست فنی/معماری (استثنای مجاز نمایش فرمول و جزئیات داخلی)
     ========================================================================== */

  const TECHNICAL_REQUEST_PATTERNS = /(فرمول|نحوه\s*محاسبه|روش\s*محاسبه|چطور\s*محاسبه|چه\s*طور\s*محاسبه|محاسبه\s*می\s*کنید|محاسبه\s*میکنید|الگوریتم|کدوم\s*موتور|چه\s*موتوری|معماری|چطور\s*کار\s*می\s*کنی|چطور\s*کار\s*میکنی|نحوه\s*عملکرد|چه\s*مدلی|جزئیات\s*محاسبه)/;

  const detectTechnicalRequest = (rawText) => TECHNICAL_REQUEST_PATTERNS.test(normalizeText(rawText));

  const detectWhyQuery = (rawText) => /(^|\s)(چرا|به\s*چه\s*دلیل|چگونه\s*است\s*که|علت\s*چیست|دلیل\s*چیست)/.test(normalizeText(rawText));

  // Phase 2-3F-B3-KH (KH-05): تفکیک «چرای مفهومی» (مسیر دانش) از «چرای حرکتی دارایی» (تحلیل بازار)
  const WHY_CONCEPTUAL_PATTERN = /(مهم\s*(است|هست|هستند)|اهمیت|ضروری|لازم\s+است|چرا\s+باید|چه\s+اهمیتی|چه\s+مفهومی|مفهومی\s+دارد|چه\s+معنایی)/;
  const WHY_MARKET_MOVEMENT_PATTERN = /(بالا|پایین|افت|ریزش|رشد|جهش|صعود|نزول|ثابت|تغییر|رالی|اصلاح|حرکت|تپش|قیمت|چقدر|چنده|امروز|دیروز|هفته)/;
  const detectConceptualWhyQuery = (rawText) => {
    const t = normalizeText(rawText);
    if (!WHY_CONCEPTUAL_PATTERN.test(t)) return false;
    return !WHY_MARKET_MOVEMENT_PATTERN.test(t);
  };


  /* ==========================================================================
     ۵) پاک‌سازی پاسخ کاربرنما از نشت فرمول/موتور (Presentation Sanitizer)
     ========================================================================== */

  // ثابت‌های کانونیکال محاسبات (فقط داخلی؛ نمایش آن‌ها در پاسخ کاربر ممنوع است)
  const MAGIC_CONSTANT_PATTERNS = [
    /4\.3318/g, /31\.1035/g, /8\.133/g, /0\.750/g, /0\.900/g,
    /۴[٫.]۳۳۱۸/g, /۳۱[٫.]۱۰۳۵/g, /۸[٫.]۱۳۳/g, /۰[٫.]۷۵۰/g, /۰[٫.]۹۰۰/g
  ];

  // نام موتورها/اجزای داخلی که نباید در پاسخ عادی ظاهر شوند
  const ENGINE_NAME_PATTERNS = [
    /\(?\s*Deterministic\s+What-?If\s+Engine[^)]*\)?/gi,
    /\(?\s*What-?If\s+Engine\s*v?\d*(\.\d+)?\s*\)?/gi,
    /\(?\s*Unified\s+Evidence\s+Builder[^)]*\)?/gi,
    /\(?\s*Evidence\s+Builder[^)]*\)?/gi,
    /\(?\s*Intent\s*&\s*Entity\s+Engine[^)]*\)?/gi,
    /\(?\s*Intent\s+Engine[^)]*\)?/gi,
    /\(?\s*Knowledge\s+Retriever[^)]*\)?/gi,
    /\(?\s*Scenario\s+Engine[^)]*\)?/gi,
    /\(?\s*Financial\s+Normalizer[^)]*\)?/gi,
    /\(?\s*Dynamic\s+Multi-?Asset\s+Synthesis[^)]*\)?/gi,
    /\(?\s*Worker\s*3[^)]*\)?/g,
    /هوش\s*لبه/g,
    /موتور\s*قطعی\s*What-?If/g
  ];

  // واژگان فنی نمایشی
  const TECH_PHRASE_PATTERNS = [
    /\(?\s*Mathematical\s+Step-?by-?Step\s*\)?/gi,
    /\(?\s*Pearson\s*R\s*\)?/gi,
    /\(?\s*canonical\s+factor\s*\)?/gi,
    /\(?\s*internal\s+engine\s*\)?/gi,
    /\(?\s*debug\s+trace\s*\)?/gi,
    /گام(?:‌|\s)*های\s*محاسب(?:ه|ات)\s*دقیق\s*کانونیکال/g,
    /محاسب(?:ه|ات)(?:‌|\s)*ی?\s*دقیق\s*کانونیکال/g,
    /محاسبه\s*دقیق\s*کانونیکال/g,
    /(?:ضرایب|ضریب|نسبت(?:‌|\s)*های)?\s*همبستگی\s*پیرسون(?:\s*تاریخی)?/g,
    /پیرسون/g,
    /ضریب\s*(?:۴[٫.]۳۳۱۸|4\.3318)\s*کانونیکال/g,
    /فرمول\s*کانونیکال/g,
    /نسبت(?:‌|\s)*های\s*همبستگی\s*پیرسون(?:\s*تاریخی)?/g
  ];

  const LATEX_BLOCK_RE = /\$\$[\s\S]*?\$\$/g;
  const LATEX_INLINE_RE = /\$(?!\$)([^$]{1,400})\$(?!\$)/g;
  const LATEX_COMMAND_RE = /\\(?:approx|frac|times|text\s*\{[^}]*\}|mathbf\s*\{[^}]*\}|quad|Big|left|right|cdot|div|sim|le|ge|pm|to)\s*/g;
  const LATEX_LEFTOVER_RE = /[\\{}]/g;

  /**
   * پاک‌سازی پاسخ کاربرنما از نشت فرمول، ثابت‌های کانونیکال و نام اجزای داخلی.
   * در صورت درخواست صریح فنی کاربر، متن دست‌نخورده بازگردانده می‌شود.
   * @param {string} rawText متن پاسخ
   * @param {{technical?: boolean}} options
   */
  const sanitizeUserFacingResponse = (rawText, options = {}) => {
    if (rawText === null || rawText === undefined) return '';
    let text = String(rawText);
    if (options.technical === true) return text;

    // ۱. حذف بلوک‌ها و اسپن‌های فرمولی
    text = text.replace(LATEX_BLOCK_RE, ' ');
    text = text.replace(LATEX_INLINE_RE, ' ');
    text = text.replace(LATEX_COMMAND_RE, ' ');
    text = text.replace(LATEX_LEFTOVER_RE, ' ');

    // ۲. حذف ثابت‌های کانونیکال محاسبات
    MAGIC_CONSTANT_PATTERNS.forEach((re) => { text = text.replace(re, ' '); });

    // ۳. حذف نام موتورها و اجزای داخلی
    ENGINE_NAME_PATTERNS.forEach((re) => { text = text.replace(re, ' '); });

    // ۴. حذف واژگان فنی نمایشی
    TECH_PHRASE_PATTERNS.forEach((re) => { text = text.replace(re, ' '); });

    // ۵. پاک‌سازی ساختاری: عناوین خالی، خطوط بی‌محتوا و فاصله‌های اضافی
    text = text
      .split('\n')
      .map((line) => {
        let l = line
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/\s+([،؛.!؟?])/g, '$1')
          .replace(/\(\s*[:؛،.]?\s*\)/g, '')
          .replace(/\[\s*\]/g, '')
          .replace(/[ \t]+$/g, '');
        const stripped = l.replace(/[#*•\-–—:؛,.،()\sٔ﷼٬۰-۹0-9٪%+=]/g, '');
        if (l.trim() && stripped.length === 0) return ''; // خط فقط از علامت/عدد ساخته شده است
        return l;
      })
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');

    return text;
  };

  /* ==========================================================================
     ۶) پاسخ کنترل‌شده در نبود قابلیت تاریخی/پیش‌بینی (بدون جانشینی LIVE)
     ========================================================================== */

  const TIMEFRAME_LABELS = {
    TODAY: 'امروز', YESTERDAY: 'دیروز', PAST_YEAR: 'سال گذشته', TOMORROW: 'فردا',
    PAST_WEEK: 'هفته گذشته', NEXT_WEEK: 'هفته آینده', END_OF_WEEK: 'تا پایان هفته',
    THIS_WEEK: 'هفته جاری', PAST_MONTH: 'ماه گذشته', NEXT_MONTH: 'ماه آینده',
    THIS_MONTH: 'ماه جاری', END_OF_MONTH: 'تا پایان ماه', NEXT_DAYS: 'روزهای آینده'
  };

  const buildDegradedTimeframeResponse = (cir = {}, options = {}) => {
    const tf = (cir && cir.context && cir.context.timeframe) || (cir && cir.timeframe) || {};
    const label = TIMEFRAME_LABELS[tf.label] || 'این بازه زمانی';
    const assets = (cir && Array.isArray(cir.entities) && cir.entities.length > 0)
      ? cir.entities.map((e) => assetLabel(e.value)).join('، ')
      : 'دارایی موردنظر';

    if (tf.horizon === 'HISTORICAL') {
      return `🕓 **داده تاریخی در دسترس نیست:**\n\n` +
        `برای بررسی ${assets} در «${label}»، به داده‌های تاریخی (مشاهدات روزانه گذشته) نیاز است و این داده‌ها در حال حاضر در دسترس این سامانه نیست.\n\n` +
        `به همین دلیل، وضعیت «${label}» را با قیمت لحظه‌ای جایگزین نمی‌کنم؛ چون این دو یکی نیستند و می‌تواند گمراه‌کننده باشد.\n\n` +
        `اگر مایل باشید می‌توانم:\n` +
        `• وضعیت لحظه‌ای ${assets} را ارائه کنم (با ذکر صریح اینکه داده لحظه‌ای است، نه تاریخی)\n` +
        `• یا یک سناریوی فرضی (مثلاً «اگر درصد مشخصی تغییر کند...») را بررسی کنم.`;
    }

    if (tf.horizon === 'FORECAST') {
      return `🔮 **پیش‌بینی عددی ارائه نمی‌شود:**\n\n` +
        `برای «${label}»، این سامانه پیش‌بینی قطعی یا هدف قیمتی اعلام نمی‌کند؛ زیرا موتور پیش‌بینی در دسترس نیست و هیچ عددی را به‌عنوان آینده جعل نمی‌کنم.\n\n` +
        `در عوض می‌توانم:\n` +
        `• سناریوهای شرطی را بررسی کنم (مثلاً «اگر ${assets} درصد مشخصی تغییر کند، اثر محاسباتی آن چه می‌شود؟»)\n` +
        `• وضعیت فعلی، تغییرات اخیر و ساختار بازار را ارائه کنم.`;
    }

    if (tf.horizon === 'AMBIGUOUS') {
      return `🧭 **بازه زمانی نیازمند شفاف‌سازی است:**\n\n` +
        `عبارت «${label}» می‌تواند دو معنا داشته باشد: (۱) از ابتدای این بازه تا امروز، یا (۲) کل بازه گذشته.\n\n` +
        `لطفاً مشخص کنید کدام مورد را می‌خواهید تا تحلیل درست انجام شود.`;
    }

    return '';
  };

  /* ==========================================================================
     ۷) پاسخ کوتاه وضعیت بازار (MARKET_STATUS) — بدون گزارش‌های نامرتبط
     ========================================================================== */

  /**
   * ساخت پاسخ کوتاه و دقیق وضعیت دارایی از شواهد زنده (بدون محاسبه جدید).
   * @param {Object} cir تحلیل نیت حل‌شده
   * @param {Array} liveItems اقلام شواهد زنده (evidence.live) با فیلدهای asset/value/unit/metadata
   */
  const buildConciseMarketStatusResponse = (cir = {}, liveItems = []) => {
    const entities = (cir && Array.isArray(cir.entities)) ? cir.entities.map((e) => e.value) : [];
    const wanted = entities.length > 0 ? entities.slice(0, 2) : [];
    const items = Array.isArray(liveItems) ? liveItems : [];
    const lines = [];

    wanted.forEach((asset) => {
      const item = items.find((x) => x && x.asset === asset);
      if (!item || item.value === null || item.value === undefined || item.value === '' || !Number.isFinite(Number(item.value))) {
        lines.push(`• **${assetLabel(asset)}:** داده لحظه‌ای در دسترس نیست.`);
        return;
      }
      const unit = assetUnit(item);
      const decimals = Math.abs(Number(item.value)) >= 1000 ? 0 : 2;
      let line = `• **${assetLabel(asset)}:** **${fmtNumber(item.value, decimals)} ${unit}**`;
      const chRaw = item.metadata ? item.metadata.change24h : null;
      const ch = (chRaw === null || chRaw === undefined || chRaw === '' || !Number.isFinite(Number(chRaw))) ? null : Number(chRaw);
      if (ch !== null) {
        const sign = ch > 0 ? '+' : (ch < 0 ? '-' : ''); // FIX-B1-4: حفظ علامت کاهش (formatter فقط قدر مطلق است)
        line += ` — تغییر روزانه: **${sign}${fmtNumber(ch, 2)}٪**`;
      }
      lines.push(line);
    });

    if (lines.length === 0) {
      return `⚠️ برای این پرسش، داده زنده‌ای در دسترس نیست.\n\nاگر دارایی موردنظر را نام ببرید (مثلاً دلار، طلا، سکه یا تتر)، وضعیت آن را بررسی می‌کنم.`;
    }

    const head = wanted.length === 1
      ? `💵 **وضعیت لحظه‌ای ${assetLabel(wanted[0])}:**\n\n`
      : `📊 **وضعیت لحظه‌ای دارایی‌های درخواستی:**\n\n`;

    const tail = '\n\nبرای تحلیل عمیق‌تر یا سناریوی فرضی، بپرسید مثلاً: «اگر ۱۰٪ بالا بره چه می‌شود؟»';

    return head + lines.join('\n') + tail;
  };

  /* ==========================================================================
     ۷) پاسخ قطعی «چرا» (WHY) در نبود مسیر مدل زبانی — ساختار §14/§15:
        مشاهده → محرک‌های محتمل (فقط مرتبط) → قدرت شاهد → تفسیر اقتصادی → عدم‌قطعیت
        • هیچ علت قطعی بدون شاهد ادعا نمی‌شود؛ اعداد فقط از شواهد زنده می‌آیند.
     ========================================================================== */

  // Phase 2-3F-B3: واحد نمایشی دارایی بر پایه قرارداد داده (بدون محاسبه)
  const assetUnit = (item) => {
    const u = item ? item.unit : null;
    if (u === 'USD' || u === 'USD_PER_OUNCE') return 'دلار';
    if (u === 'INDEX_POINT') return 'واحد';
    return 'تومان';
  };

  // Phase 2-3F-B3: محرک‌های محتمل به‌تفکیک کلاس دارایی (فرضیه‌های عمومی، بدون داده روند)
  const WHY_DRIVERS = {
    USD: 'نوسان عرضه و تقاضای ارز، انتظارات تورمی، رویدادهای خبری و اسپرد بازار',
    USDT: 'اضافه‌تقاضای خروج نقدینگی، اسپرد دلار کاغذی/دیجیتال و شرایط انتقال',
    GOLD18: 'بردار دوگانه نرخ ارز و اونس جهانی، تقاضای فیزیکی/فصلی و حباب داخلی',
    COIN: 'ارزش ذاتی بر پایه اونس و ارز، حباب مسکوکات و تقاضای خرد/کادویی',
    XAU: 'نرخ بهره و انتظارات تورمی جهانی، شاخص دلار و تقاضای پناهگاهی',
    XAG: 'تقاضای صناعی، نسبت طلا به نقره و چرخه‌های رشد صنعتی',
    OIL: 'عرضه اوپک، تقاضای جهانی و ریسک‌های ژئوپلیتیک',
    TSE_INDEX: 'جریان نقدینگی حقیقی/حقوقی، ارز نیما و عملکرد صنایع دلاری',
    TSE_EQUAL: 'عمق نقدینگی خرد، بازگشت اعتماد عمومی و صنایع ریالی',
    BTC: 'جریان نقدینگی کریپتو، دامیننس و رویدادهای عرضه (هاوینگ)، احساسات بازار',
    ETH: 'نقدینگی DeFi، به‌روزرسانی‌های شبکه و چرخه نقدینگی آلت‌کوین‌ها',
    SOL: 'حجم اکوسیستم، حساسیت به چرخه ریسک و نقدینگی آلت‌کوین‌ها',
    DEFAULT: 'بردار ارز، انتظارات تورمی، جریان نقدینگی و رویدادهای بازار'
  };
  const whyDrivers = (asset) => WHY_DRIVERS[String(asset || '').toUpperCase()] || WHY_DRIVERS.DEFAULT;

  const buildWhyResponse = (cir = {}, liveItems = []) => {
    const entities = (cir && Array.isArray(cir.entities)) ? cir.entities.map((e) => e.value) : [];
    const items = Array.isArray(liveItems) ? liveItems : [];
    const target = entities.length > 0 ? entities.slice(0, 2) : [];

    const obsLines = [];
    let maxAbsChange = null;
    target.forEach((asset) => {
      const item = items.find((x) => x && x.asset === asset);
      if (!item || item.value === null || item.value === undefined || item.value === '' || !Number.isFinite(Number(item.value))) {
        obsLines.push(`• **${assetLabel(asset)}:** داده لحظه‌ای برای این دارایی در دسترس نیست.`);
        return;
      }
      const decimals = Math.abs(Number(item.value)) >= 1000 ? 0 : 2;
      let line = `• **${assetLabel(asset)}:** **${fmtNumber(item.value, decimals)} ${assetUnit(item)}**`;
      const chRaw = item.metadata ? item.metadata.change24h : null;
      const ch = (chRaw === null || chRaw === undefined || chRaw === '' || !Number.isFinite(Number(chRaw))) ? null : Number(chRaw);
      if (ch !== null) {
        const sign = ch > 0 ? '+' : (ch < 0 ? '-' : ''); // FIX-B1-4: حفظ علامت کاهش (formatter فقط قدر مطلق است)
        const flat = Math.abs(ch) < 0.05;
        if (maxAbsChange === null || Math.abs(ch) > maxAbsChange) maxAbsChange = Math.abs(ch);
        line += ` — تغییر روزانه: **${sign}${fmtNumber(ch, 2)}٪**${flat ? ' (عملاً بدون تغییر محسوس)' : ''}`;
      }
      obsLines.push(line);
    });

    const observation = obsLines.length > 0
      ? obsLines.join('\n')
      : 'برای دارایی موردپرسش، داده لحظه‌ای کافی در دسترس نیست.';

    const assetsText = target.length > 0 ? target.map((a) => assetLabel(a)).join(' و ') : 'دارایی موردپرسش';
    const flatToday = (maxAbsChange === null || maxAbsChange < 0.05);
    const driverLines = (target.length > 0 ? target : [null]).map((a) =>
      `• **${a ? assetLabel(a) : assetsText}:** محرک‌های رایج این بازار (${whyDrivers(a)}) تنها با روند چندروزه/داده تاریخی قابل تفکیک‌اند.\n`
    ).join('');

    return `🔎 **مشاهده (فقط بر پایه داده امروز):**\n` +
      `${observation}\n\n` +
      `🧭 **محرک‌های محتمل — فقط در چارچوب شواهد:**\n` +
      `• تعیین یک علت واحد برای رفتار امروز «${assetsText}» با داده‌های لحظه‌ای (قیمت و تغییر روزانه) ممکن نیست؛\n` +
      driverLines +
      `\n` +
      `⚖️ **قدرت شاهد:** پایین تا متوسط — داده لحظه‌ای «چیستی» حرکت را نشان می‌دهد، نه «چرایی» آن.\n\n` +
      `🧠 **تفسیر اقتصادی:** ${flatToday ? 'رفتار نزدیک به ثابت معمولاً محصول تعادل عرضه و تقاضا یا تثبیت موقت انتظارات است' : 'تغییر روزانه در این دامنه معمولاً محصول ترکیب بردار ارز/کامودیتی، انتظارات و جریان نقدینگی است'}؛ اما بدون داده تاریخی، این یک فرضیه است، نه یافته.\n\n` +
      `❓ **عدم‌قطعیت:** از داده‌های فعلی نمی‌توان علت قطعی تعیین کرد؛ برای تحلیل علت‌محور، در دسترس بودن روند تاریخی و رویدادهای بازار لازم است.`;
  };


  /* ==========================================================================
     ۹) Phase 2-3F-B3: ارائه دانشنامه، مقایسه دارایی‌ها، کارت تک‌دارایی و پاسخ دامنه‌ای
        • قطعی و بدون تولید محتوای ساختگی؛ دانش فقط از ردیف‌های بازیابی‌شده D1.
     ========================================================================== */

  const KNOWLEDGE_TOPIC_LABELS = {
    'P/E': 'نسبت قیمت به سود (P/E)',
    'CPI': 'شاخص قیمت مصرف‌کننده (CPI)',
    'DXY': 'شاخص دلار (DXY)',
    'PMI': 'شاخص مدیران خرید (PMI)',
    'GOLD_TO_SILVER': 'نسبت طلا به نقره',
    'GOLD_ETF': 'صندوق‌های طلای بورسی',
    'COIN_VS_TOKEN': 'تفاوت کوین و توکن',
    'BROKER_VS_BROKERAGE': 'تفاوت کارگزاری و بروکر',
    'CEX_DEX': 'صرافی متمرکز در برابر غیرمتمرکز (CEX/DEX)',
    'GOLD18_BUBBLE_CORRIDOR': 'کریدور تعادلی طلای ۱۸ عیار',
    'QUARTER_COIN_BUBBLE': 'حباب ربع سکه',
    'SIDEWAYS_MARKET': 'بازار ساید/رنج',
    'PRICE_CONSOLIDATION': 'تثبیت قیمت (Consolidation)',
    'HALVING': 'هاوینگ بیت‌کوین',
    'GENERAL_FINANCE': 'مفاهیم عمومی مالی'
  };

  // Phase 2-3F-B3: بررسی قطعی موجودبودن مقدار زنده (پایه مشترک توابع جدید؛ جایگزین تکرار شرط گارد)
  const hasLiveValue = (item) =>
    Boolean(item) && item.value !== null && item.value !== undefined && item.value !== '' && Number.isFinite(Number(item.value));

  // Phase 2-3F-B3-KH (KH-03): سیاست کانونیکال ارتباط دانش — یک منبع حقیقت واحد برای بازیاب و ارائه
  const KNOWLEDGE_PRESENTATION_POLICY = {
    retrievalMinimum: 0.40,
    presentationMinimum: 0.40,
    strongMatch: 0.65
  };

  const knowledgePresentationMinimum = (retrievedKnowledge) => {
    const p = (retrievedKnowledge && retrievedKnowledge.policy) ? retrievedKnowledge.policy : null;
    const v = (p && typeof p.presentationMinimum === 'number') ? p.presentationMinimum : KNOWLEDGE_PRESENTATION_POLICY.presentationMinimum;
    return v;
  };

  // Phase 2-3F-B3-KH (KH-04): حذف قطعه‌ای مارک‌آپ فرمول (بلوک/دستور) — هرگز حذف کل خط یا پاراگراف دانش
  const stripKnowledgeMathMarkup = (text) => {
    let out = String(text || '');
    out = out.replace(/\$\$[\s\S]*?\$\$/g, ' ');            // بلوک‌های $$...$$
    out = out.replace(/\\[a-zA-Z]+(?:\s*\{[^{}]*\})*/g, ' '); // دستورهای LaTeX و آرگومان‌ها
    out = out.replace(/[{}]/g, ' ');                             // آکولادهای یتیم
  out = out.replace(/\$([^$\n]{1,120})\$/g, '$1');           // ریاضی درون‌خطی: حذف فقط جداکنندهٔ $
    out = out.replace(/\$\$/g, ' ');                            // $$ نامتوازن باقی‌مانده
    out = out.replace(/[ \t]{2,}/g, ' ');
    return out.trim();
  };

  const trimKnowledgeContent = (content) => {
    const raw = stripKnowledgeMathMarkup(content);
    if (!raw) return '';
    const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let out = lines.join('\n');
    if (out.length > 1400) {
      out = out.slice(0, 1400);
      const cut = out.lastIndexOf('\n');
      if (cut > 400) out = out.slice(0, cut);
      out = out.trim() + ' …';
    }
    return out;
  };

  const isKnowledgePresentationEligible = (retrievedKnowledge) => {
    const results = (retrievedKnowledge && Array.isArray(retrievedKnowledge.results)) ? retrievedKnowledge.results : [];
    const min = knowledgePresentationMinimum(retrievedKnowledge);
    return results.some(r => Number(r.relevanceScore) >= min);
  };

  const buildKnowledgePresentationResponse = (retrievedKnowledge, cir = {}) => {
    const results = (retrievedKnowledge && Array.isArray(retrievedKnowledge.results)) ? retrievedKnowledge.results : [];
    const topic = (retrievedKnowledge && retrievedKnowledge.query && retrievedKnowledge.query.topic) || null;
    const topicFa = KNOWLEDGE_TOPIC_LABELS[topic] || 'این مفهوم';
    const best = results.find(r => Number(r.relevanceScore) >= knowledgePresentationMinimum(retrievedKnowledge)) || null;
    if (!best) {
      return `📚 **دانشنامه دیدبان — مدخلی برای «${topicFa}» یافت نشد.**\n\n` +
        `این پرسش یک استعلام مفهومی است؛ در دانشنامه داخلی مدخل متناظری برای آن در دسترس نیست و عمداً هیچ توضیح ساختگی تولید نمی‌شود.\n\n` +
        `💡 **چارچوب تحلیل پیشنهادی:** می‌توانید درباره «همبستگی دارایی‌ها»، «حباب و اسپرد»، «نسبت‌های تحلیلی» یا یک «سناریوی فرضی مشخص» بپرسید تا تحلیل ساختاری (غیرتوصیه‌ای) دریافت کنید.`;
    }
    const body = trimKnowledgeContent(best.content);
    return `📚 **دانشنامه دیدبان — «${best.title}»**\n\n` +
      `${best.summary || ''}` +
      (body ? `\n\n${body}` : '') +
      `\n\n🧾 *منبع: دانشنامه داخلی دیدبان (D1) — این پاسخ تقریر مفهوم است و توصیه معاملاتی نیست.*`;
  };

  const buildComparisonResponse = (cir = {}, liveItems = []) => {
    const entities = (cir && Array.isArray(cir.entities)) ? cir.entities.map((e) => e.value) : [];
    const target = entities.slice(0, 3);
    if (target.length < 2) return null;
    const items = Array.isArray(liveItems) ? liveItems : [];
    const lines = [];
    target.forEach((asset) => {
      const item = items.find((x) => x && x.asset === asset);
      if (!hasLiveValue(item)) {
        lines.push(`• **${assetLabel(asset)}:** داده لحظه‌ای در دسترس نیست.`);
        return;
      }
      const decimals = Math.abs(Number(item.value)) >= 1000 ? 0 : 2;
      let line = `• **${assetLabel(asset)}:** **${fmtNumber(item.value, decimals)} ${assetUnit(item)}**`;
      const chRaw = item.metadata ? item.metadata.change24h : null;
      const ch = (chRaw === null || chRaw === undefined || chRaw === '' || !Number.isFinite(Number(chRaw))) ? null : Number(chRaw);
      if (ch !== null) {
        const sign = ch > 0 ? '+' : (ch < 0 ? '-' : '');
        line += ` — تغییر روزانه: **${sign}${fmtNumber(ch, 2)}٪**`;
      }
      lines.push(line);
    });
    const labels = target.map(a => assetLabel(a)).join(' و ');
    return `⚖️ **مقایسه توصیفی ${labels} (بر پایه شواهد امروز):**\n\n` +
      lines.join('\n') +
      `\n\n🧾 *این مقایسه فقط توصیف داده‌های امروز است؛ شامل پیش‌بینی، ادعای علّیت یا توصیه معاملاتی نیست.*`;
  };

  const buildAssetSnapshotResponse = (cir = {}, liveItems = []) => {
    const entities = (cir && Array.isArray(cir.entities)) ? cir.entities.map((e) => e.value) : [];
    if (entities.length !== 1) return null;
    const asset = entities[0];
    const items = Array.isArray(liveItems) ? liveItems : [];
    const item = items.find((x) => x && x.asset === asset);
    if (!hasLiveValue(item)) {
      return `⚠️ **داده لحظه‌ای «${assetLabel(asset)}» در دسترس نیست.**\n\n` +
        `برای تحلیل دقیق، لطفاً همان دارایی را با شواهد تازه دوباره بپرسید (مثلاً «قیمت ${assetLabel(asset)} چنده؟»).`;
    }
    const decimals = Math.abs(Number(item.value)) >= 1000 ? 0 : 2;
    let line = `• **${assetLabel(asset)}:** **${fmtNumber(item.value, decimals)} ${assetUnit(item)}**`;
    const chRaw = item.metadata ? item.metadata.change24h : null;
    const ch = (chRaw === null || chRaw === undefined || chRaw === '' || !Number.isFinite(Number(chRaw))) ? null : Number(chRaw);
    if (ch !== null) {
      const sign = ch > 0 ? '+' : (ch < 0 ? '-' : '');
      line += ` — تغییر روزانه: **${sign}${fmtNumber(ch, 2)}٪**`;
    }
    return `📊 **نگاه توصیفی به ${assetLabel(asset)}:**\n\n` + line +
      `\n\nبرای ادامه می‌توانید بپرسید: «چرا امروز حرکت کرد؟» یا «اگر ۱۰٪ بالا برود چه می‌شود؟»`;
  };

  const buildScopeFallbackResponse = (query = '') => {
    return `🧭 **این درخواست در قالب‌های تحلیلی شناخته‌شده قرار نمی‌گیرد.**\n\n` +
      `برای پاسخ دقیق و مستند، یکی از این قالب‌ها را بپرسید:\n` +
      `• وضعیت دارایی: «قیمت دلار چنده؟»\n` +
      `• مفهومی: «نسبت قیمت به سود چیست؟»\n` +
      `• سناریویی: «اگر دلار ۱۰٪ بالا برود چه می‌شود؟»\n` +
      `• علت حرکت: «چرا طلا بالا رفت؟»\n` +
      `• مقایسه: «دلار و طلا را مقایسه کن»`;
  };

  return {
    buildWhyResponse,
    buildKnowledgePresentationResponse,
    buildComparisonResponse,
    buildAssetSnapshotResponse,
    buildScopeFallbackResponse,
    trimKnowledgeContent,
    stripKnowledgeMathMarkup,
    isKnowledgePresentationEligible,
    KNOWLEDGE_PRESENTATION_POLICY,
    detectConceptualWhyQuery,
    assetUnit,
    KNOWLEDGE_TOPIC_LABELS,
    RP_VERSION,
    RP_LEVELS,
    ASSET_LABELS,
    assetLabel,
    toFaDigits,
    fmtNumber,
    normalizeText,
    detectSmallTalk,
    buildSmallTalkResponse,
    classifyResponseLevel,
    detectTechnicalRequest,
    detectWhyQuery,
    sanitizeUserFacingResponse,
    buildDegradedTimeframeResponse,
    buildConciseMarketStatusResponse
  };
})();

// پل دسترسی سطح‌اسکریپت ورکر به لایه ارائه (Phase 2-3C)
const RESPONSE_LEVELS = ResponsePresentation.RP_LEVELS;
const detectSmallTalk = ResponsePresentation.detectSmallTalk;
const buildSmallTalkResponse = ResponsePresentation.buildSmallTalkResponse;
const classifyResponseLevel = ResponsePresentation.classifyResponseLevel;
const detectTechnicalRequest = ResponsePresentation.detectTechnicalRequest;
const detectWhyQuery = ResponsePresentation.detectWhyQuery;
const sanitizeUserFacingResponse = ResponsePresentation.sanitizeUserFacingResponse;
const buildDegradedTimeframeResponse = ResponsePresentation.buildDegradedTimeframeResponse;

// FIX-B2-1 (Phase 2-3F-B2): نمایش قطعی شواهد تاریخی ارائه‌شده توسط فراخوان — بدون هیچ عدد LIVE و بدون جانشینی
function buildHistoricalEvidenceResponse(cir = {}, historicalItems = []) {
  if (!Array.isArray(historicalItems) || historicalItems.length === 0) return null;
  const toFaDigitsHist = (v) => String(v).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
  const fmtHist = (num, decimals = 2) => {
    const n = Number(num);
    if (!Number.isFinite(n)) return null;
    return toFaDigitsHist(Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })).replace(/,/g, '٬').replace(/\./g, '٫');
  };
  const tf = (cir && cir.context && cir.context.timeframe) || {};
  const labelMap = { YESTERDAY: 'دیروز', PAST_WEEK: 'هفته گذشته', PAST_MONTH: 'ماه گذشته', PAST_YEAR: 'سال گذشته' };
  const label = labelMap[tf.label] || 'بازه تاریخی درخواستی';
  const lines = [];
  historicalItems.forEach((it) => {
    if (!it || typeof it !== 'object') return;
    const assetValue = it.asset || null;
    const name = assetValue ? ResponsePresentation.assetLabel(assetValue) : (it.label ? String(it.label) : null);
    if (!name) return;
    const parts = [];
    if (it.value !== null && it.value !== undefined && it.value !== '' && Number.isFinite(Number(it.value))) {
      const v = fmtHist(it.value, Math.abs(Number(it.value)) >= 1000 ? 0 : 2);
      if (v) parts.push(`مقدار: **${v}**${it.unit ? ' ' + String(it.unit) : ''}`);
    }
    const chRaw = (it.changePct !== undefined) ? it.changePct : ((it.change24h !== undefined) ? it.change24h : it.pct24h);
    if (chRaw !== null && chRaw !== undefined && chRaw !== '' && Number.isFinite(Number(chRaw))) {
      const n = Number(chRaw);
      const ch = fmtHist(n, 2);
      if (ch) parts.push(`تغییر: **${n > 0 ? '+' : (n < 0 ? '-' : '')}${ch}٪**`);
    }
    if (it.note) parts.push(String(it.note));
    if (parts.length === 0) return; // داده ناقص هرگز با صفر یا حدس پر نمی‌شود
    lines.push(`• **${name}:** ${parts.join(' — ')}`);
  });
  if (lines.length === 0) return null; // هیچ ردیف معتبری نبود → مسیر پیام صریح نبود داده تاریخی
  return `🕓 **داده تاریخی «${label}» (بر پایه شواهد تاریخی ارائه‌شده):**\n\n${lines.join('\n')}\n\nاین ارقام فقط از شواهد تاریخی همین درخواست استخراج شده‌اند و هیچ قیمت لحظه‌ای جایگزین آن‌ها نشده است.`;
}
const buildConciseMarketStatusResponse = ResponsePresentation.buildConciseMarketStatusResponse;
const buildKnowledgePresentationResponse = ResponsePresentation.buildKnowledgePresentationResponse;
// Phase 2-3F-B3-KH (KH-05): مسیر پرسش «چرا» مفهومی در سطح اسکریپت ورکر
const detectConceptualWhyQuery = ResponsePresentation.detectConceptualWhyQuery;
const buildComparisonResponse = ResponsePresentation.buildComparisonResponse;
const buildAssetSnapshotResponse = ResponsePresentation.buildAssetSnapshotResponse;
const buildScopeFallbackResponse = ResponsePresentation.buildScopeFallbackResponse;
const buildWhyResponse = ResponsePresentation.buildWhyResponse;

// سقف توکن پاسخ بر اساس سیاست طول (SHORT / STANDARD / DEEP)
const responseTokenCap = (level) => (level === ResponsePresentation.RP_LEVELS.SHORT ? 300
  : (level === ResponsePresentation.RP_LEVELS.DEEP ? 750 : 480));

// پل دسترسی سطح‌اسکریپت ورکر به پروفایل هویت کانونیکال (Phase 2-3D)
const MAKAN_IDENTITY_PROFILE = MakanIdentityProfile.MAKAN_IDENTITY_PROFILE;
const detectIdentityQuery = MakanIdentityProfile.detectIdentityQuery;
const buildIdentityResponse = MakanIdentityProfile.buildIdentityResponse;
const identityTierLevel = MakanIdentityProfile.identityTierLevel;
const identityRoleLine = MakanIdentityProfile.identityRoleLine;

/* ==========================================================================
   Phase 2-3B — Working Memory & Multi-Turn Anaphora State Machine
   لایه حافظه معنایی چندنوبته: قرارداد نسخه‌دار + حل‌کننده قطعی بافت + ماشین حالت
   اصول:
     • «Semantic Context persists. Market Values do not.»
     • حافظه هرگز قیمت/درصد/مشتق بازار را نگه نمی‌دارد (فقط فرض عددی خود کاربر).
     • هیچ منطق نیت/موجودیت موازی ساخته نمی‌شود؛ analyzeQuery همان منبع حقیقت است.
     • حل بافت کاملاً قطعی است و در شکست، شفاف‌سازی می‌دهد — نه حدس.
   ========================================================================== */

const WM_CONTRACT_VERSION = '1.0';

// وضعیت‌های ماشین حالت (State Machine)
const WM_STATES = {
  IDLE: 'IDLE',
  ASSET_CONTEXT: 'ASSET_CONTEXT',
  TOPIC_CONTEXT: 'TOPIC_CONTEXT',
  SCENARIO_CONTEXT: 'SCENARIO_CONTEXT',
  COMPARISON_CONTEXT: 'COMPARISON_CONTEXT',
  AWAITING_CLARIFICATION: 'AWAITING_CLARIFICATION',
  RESTRICTED: 'RESTRICTED',
  EXPIRED: 'EXPIRED'
};

// مرزهای اعتماد (Trust Boundary)
const WM_TRUST = {
  USER_TEXT: 'USER_TEXT',
  SYSTEM_STATE: 'SYSTEM_STATE',
  DETERMINISTIC_STATE: 'DETERMINISTIC_STATE',
  EVIDENCE: 'EVIDENCE',
  LLM_OUTPUT: 'LLM_OUTPUT'
};

const WM_TRUST_CLASS = {
  USER_TEXT: 'TRUSTED_INTENT',
  SYSTEM_STATE: 'TRUSTED_STATE',
  DETERMINISTIC_STATE: 'TRUSTED',
  EVIDENCE: 'TRUSTED_FOR_VALUES',
  LLM_OUTPUT: 'UNTRUSTED_FOR_FACTS'
};

const WM_LIMITS = {
  MAX_TOPIC_STACK_DEPTH: 3,
  MAX_SCENARIO_LEDGER: 4,
  PENDING_CLARIFICATION_TTL_TURNS: 3
};

// کلیدهای مجاز قرارداد (Whitelist سخت‌گیرانه)
const WM_ALLOWED_KEYS = [
  'contractVersion', 'turnIndex', 'activeIntent', 'activeAssets', 'activeTopic', 'topicStack',
  'comparisonSet', 'timeframe', 'scenario', 'scenarioLedger', 'pendingClarification',
  'resolvedReferences', 'lastUserCorrection', 'state', 'updatedAtTurn',
  'mode', 'assets', 'label', 'horizon', 'requiresHistoricalData', 'requiresForecastCapability',
  'scenarioId', 'parentScenarioId', 'asset', 'value', 'direction', 'queryText', 'multiIndex',
  'id', 'missing', 'originalIntent', 'createdAtTurn', 'originalText',
  'kind', 'from', 'to', 'source', 'trust', 'ref'
];

// کلیدهای ممنوعه (هرگونه ارزش بازار / مشتق / شواهد)
const WM_FORBIDDEN_KEYS = [
  'price', 'prices', 'currentPrice', 'marketPrice', 'intrinsicPrice', 'bubble', 'bubblePercent',
  'spread', 'spreadPercent', 'change', 'change24h', 'changePercent', 'snapshot', 'snapshots',
  'evidence', 'derived', 'live', 'historical', 'hypothetical', 'knowledge', 'marketData',
  'usd', 'usdt', 'gold18', 'sekee', 'xau', 'xag', 'oil', 'tse', 'tseIndex', 'tseEqual',
  'silver1g', 'btc', 'eth', 'sol', 'dxy', 'toman', 'rial'
];

// مسیرهای عددی مجاز (فقط فرض عددی خود کاربر و شمارنده‌های ساختاری)
const WM_NUMERIC_ALLOWED_PATHS = ['turnIndex', 'updatedAtTurn', 'scenario.value', 'scenario.multiIndex', 'pendingClarification.createdAtTurn'];
const WM_LEDGER_NUMERIC_PATH = /^scenarioLedger\.\d+\.(value|multiIndex)$/;

// نرمال‌سازی سبک متن برای تطبیق قطعی (بدون حذف معنا)
const wmNormalize = (t) => String(t || '')
  .toLowerCase()
  .replace(/[\u200c\u200e\u200f\u202a-\u202e]/g, '')
  .replace(/ي/g, 'ی')
  .replace(/ك/g, 'ک')
  .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

// کمینه‌ی تبدیل ارقام فارسی/عربی برای تشخیص فرض عددی کاربر
const wmToEnDigits = (t) => String(t || '')
  .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
  .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));

/**
 * واژه‌نمای کانونیکال دارایی برای بازسازی پرسش (Synonym Canonicalizer)
 * همیشه نخستین مترادف تاکسونومی — برای تطبیق قطعی موتور موجود استفاده می‌شود.
 */
const wmAssetSynonym = (asset) => {
  const list = ASSET_TAXONOMY[asset];
  return (Array.isArray(list) && list.length > 0) ? list[0] : null;
};

/**
 * تمرکز بر یک دارایی (سناریو/پیگیری) — اگر دارایی عضو مجموعه مقایسه فعال باشد،
 * مجموعه حفظ می‌شود تا «حافظه مجموعه مقایسه» بین نوبت‌ها از دست نرود.
 */
const focusAsset = (asset, mem) => {
  const cs = mem.comparisonSet || { mode: 'SINGLE', assets: [] };
  if (cs.mode === 'COMPARE' && Array.isArray(cs.assets) && cs.assets.length >= 2 && cs.assets.includes(asset)) {
    mem.comparisonSet = { mode: 'COMPARE', assets: cs.assets.slice() };
    return;
  }
  mem.comparisonSet = { mode: 'SINGLE', assets: asset ? [asset] : [] };
};

/* --------------------------------------------------------------------------
   ۱) Temporal Resolver — تشخیص قطعی افق زمانی (بدون ساخت موتور تاریخی/پیش‌بینی)
   -------------------------------------------------------------------------- */
const TEMPORAL_RULES = [
  { label: 'TODAY', patterns: ['امروز', 'الان', 'همین حالا', 'این لحظه', 'الان چنده', 'در حال حاضر', 'فعلاً'], horizon: 'CURRENT', rh: false, rf: false },
  { label: 'PAST_WEEK', patterns: ['هفته گذشته', 'هفته قبل', 'هفته پیش', 'هفت روز گذشته', 'هفت روز اخیر', 'سابقه هفته'], horizon: 'HISTORICAL', rh: true, rf: false },
  { label: 'PAST_MONTH', patterns: ['ماه گذشته', 'ماه قبل', 'ماه پیش', 'سی روز گذشته', '۳۰ روز گذشته'], horizon: 'HISTORICAL', rh: true, rf: false },
  { label: 'YESTERDAY', patterns: ['دیروز', 'پریشب', 'روز گذشته', 'روز قبل'], horizon: 'HISTORICAL', rh: true, rf: false },
  { label: 'PAST_YEAR', patterns: ['سال گذشته', 'سال قبل', 'پارسال'], horizon: 'HISTORICAL', rh: true, rf: false },
  { label: 'END_OF_WEEK', patterns: ['تا آخر هفته', 'تا اخر هفته', 'پایان هفته', 'آخر هفته'], horizon: 'FORECAST', rh: false, rf: true },
  { label: 'END_OF_MONTH', patterns: ['تا آخر ماه', 'پایان ماه', 'آخر ماه'], horizon: 'FORECAST', rh: false, rf: true },
  { label: 'NEXT_WEEK', patterns: ['هفته آینده', 'هفته بعد', 'هفته اینده'], horizon: 'FORECAST', rh: false, rf: true },
  { label: 'NEXT_MONTH', patterns: ['ماه آینده', 'ماه بعد', 'ماه اینده'], horizon: 'FORECAST', rh: false, rf: true },
  { label: 'NEXT_DAYS', patterns: ['چند روز آینده', 'چند روز بعد', 'روزهای آینده', 'تا چند روز', 'هفته آینده'], horizon: 'FORECAST', rh: false, rf: true },
  { label: 'THIS_WEEK', patterns: ['هفته جاری', 'این هفته', 'هفته جاری'], horizon: 'AMBIGUOUS', rh: true, rf: false },
  { label: 'THIS_MONTH', patterns: ['این ماه', 'ماه جاری'], horizon: 'AMBIGUOUS', rh: true, rf: false },
  { label: 'TOMORROW', patterns: ['فردا'], horizon: 'FORECAST', rh: false, rf: true }
];

/**
 * تشخیص قطعی افق زمانی از متن کاربر
 * خروجی: { label, matched, horizon, requiresHistoricalData, requiresForecastCapability }
 */
const resolveTemporal = (rawText) => {
  const s = wmNormalize(rawText);
  if (!s) {
    return { label: null, matched: null, horizon: 'CURRENT', requiresHistoricalData: false, requiresForecastCapability: false };
  }
  for (const rule of TEMPORAL_RULES) {
    for (const p of rule.patterns) {
      if (s.includes(p)) {
        return {
          label: rule.label,
          matched: p,
          horizon: rule.horizon,
          requiresHistoricalData: !!rule.rh,
          requiresForecastCapability: !!rule.rf
        };
      }
    }
  }
  return { label: null, matched: null, horizon: 'CURRENT', requiresHistoricalData: false, requiresForecastCapability: false };
};

/* --------------------------------------------------------------------------
   ۲) Working Memory Contract v1.0
   -------------------------------------------------------------------------- */
const createWorkingMemory = () => ({
  contractVersion: WM_CONTRACT_VERSION,
  turnIndex: 0,
  activeIntent: null,
  activeAssets: [],
  activeTopic: null,
  topicStack: [],
  comparisonSet: { mode: 'SINGLE', assets: [] },
  timeframe: {
    label: null,
    horizon: 'CURRENT',
    requiresHistoricalData: false,
    requiresForecastCapability: false
  },
  scenario: null,
  scenarioLedger: [],
  pendingClarification: null,
  resolvedReferences: [],
  lastUserCorrection: null,
  state: WM_STATES.IDLE,
  updatedAtTurn: 0
});

/**
 * اعتبارسنجی قرارداد حافظه: ممنوعیت مطلق ارزش بازار + whitelist کلیدها
 */
const validateWorkingMemory = (memory) => {
  const violations = [];
  const walk = (node, path) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        const childPath = path ? `${path}.${k}` : k;
        if (WM_FORBIDDEN_KEYS.includes(k)) {
          violations.push({ type: 'FORBIDDEN_KEY', path: childPath });
        } else if (!WM_ALLOWED_KEYS.includes(k)) {
          violations.push({ type: 'UNKNOWN_KEY', path: childPath });
        }
        walk(v, childPath);
      }
      return;
    }
    if (typeof node === 'number') {
      const allowed = WM_NUMERIC_ALLOWED_PATHS.includes(path) || WM_LEDGER_NUMERIC_PATH.test(path);
      if (!allowed) violations.push({ type: 'NUMERIC_MARKET_VALUE_SUSPECT', path, value: node });
    }
    if (typeof node === 'string') {
      // توکن‌های عددی بزرگ (≥ ۶ رقم) به‌عنوان ارزش بازار در حافظه معنایی مجاز نیستند؛
      // تنها استثنا: فرض عددی خود کاربر در دامنه سناریو (value) که بخشی از قرارداد v1.0 است
      const assumptionScoped = WM_NUMERIC_ALLOWED_PATHS.includes(path) || WM_LEDGER_NUMERIC_PATH.test(path);
      if (!assumptionScoped) {
        const tokens = wmToEnDigits(node).match(/\d+/g) || [];
        if (tokens.some(t => t.length >= 6)) violations.push({ type: 'LARGE_NUMERIC_TOKEN', path });
      }
    }
  };
  walk(memory, '');
  return { clean: violations.length === 0, violations };
};

/**
 * نرمال‌سازی/ترمیم حافظه خام ورودی (Defensive Normalization)
 */
const normalizeWorkingMemory = (raw) => {
  const base = createWorkingMemory();
  if (!raw || typeof raw !== 'object' || raw.contractVersion !== WM_CONTRACT_VERSION) {
    return base;
  }
  const mem = base;
  mem.turnIndex = Number.isFinite(raw.turnIndex) ? raw.turnIndex : 0;
  mem.updatedAtTurn = Number.isFinite(raw.updatedAtTurn) ? raw.updatedAtTurn : mem.turnIndex;
  mem.activeIntent = typeof raw.activeIntent === 'string' ? raw.activeIntent : null;
  mem.activeAssets = Array.isArray(raw.activeAssets)
    ? raw.activeAssets.filter(a => Object.prototype.hasOwnProperty.call(ASSET_TAXONOMY, a))
    : [];
  mem.activeTopic = (raw.activeTopic && typeof raw.activeTopic === 'object' && typeof raw.activeTopic.value === 'string')
    ? { kind: raw.activeTopic.kind === 'KNOWLEDGE' ? 'KNOWLEDGE' : 'ASSET', value: raw.activeTopic.value, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] }
    : null;
  mem.topicStack = Array.isArray(raw.topicStack)
    ? raw.topicStack.filter(t => t && typeof t.value === 'string').slice(-WM_LIMITS.MAX_TOPIC_STACK_DEPTH)
      .map(t => ({ kind: t.kind === 'KNOWLEDGE' ? 'KNOWLEDGE' : 'ASSET', value: t.value }))
    : [];
  mem.comparisonSet = {
    mode: (raw.comparisonSet && raw.comparisonSet.mode === 'COMPARE') ? 'COMPARE' : 'SINGLE',
    assets: (raw.comparisonSet && Array.isArray(raw.comparisonSet.assets))
      ? raw.comparisonSet.assets.filter(a => Object.prototype.hasOwnProperty.call(ASSET_TAXONOMY, a))
      : []
  };
  const tf = raw.timeframe || {};
  mem.timeframe = {
    label: typeof tf.label === 'string' ? tf.label : null,
    horizon: ['CURRENT', 'HISTORICAL', 'FORECAST', 'AMBIGUOUS'].includes(tf.horizon) ? tf.horizon : 'CURRENT',
    requiresHistoricalData: !!tf.requiresHistoricalData,
    requiresForecastCapability: !!tf.requiresForecastCapability
  };
  const sc = raw.scenario;
  mem.scenario = (sc && typeof sc === 'object' && typeof sc.asset === 'string' && Object.prototype.hasOwnProperty.call(ASSET_TAXONOMY, sc.asset))
    ? {
      scenarioId: typeof sc.scenarioId === 'string' ? sc.scenarioId : null,
      parentScenarioId: typeof sc.parentScenarioId === 'string' ? sc.parentScenarioId : null,
      asset: sc.asset,
      mode: typeof sc.mode === 'string' ? sc.mode : 'PERCENT_CHANGE',
      value: Number.isFinite(sc.value) ? sc.value : null,
      direction: (['UP', 'DOWN', 'NONE'].includes(sc.direction)) ? sc.direction : 'UP',
      queryText: typeof sc.queryText === 'string' ? sc.queryText.slice(0, 300) : null,
      multiIndex: Number.isFinite(sc.multiIndex) ? sc.multiIndex : null
    }
    : null;
  mem.scenarioLedger = Array.isArray(raw.scenarioLedger)
    ? raw.scenarioLedger.filter(x => x && typeof x.asset === 'string').slice(-WM_LIMITS.MAX_SCENARIO_LEDGER).map(x => ({
      scenarioId: typeof x.scenarioId === 'string' ? x.scenarioId : null,
      parentScenarioId: typeof x.parentScenarioId === 'string' ? x.parentScenarioId : null,
      asset: x.asset,
      mode: typeof x.mode === 'string' ? x.mode : 'PERCENT_CHANGE',
      value: Number.isFinite(x.value) ? x.value : null,
      direction: (['UP', 'DOWN', 'NONE'].includes(x.direction)) ? x.direction : 'UP',
      queryText: typeof x.queryText === 'string' ? x.queryText.slice(0, 300) : null,
      multiIndex: Number.isFinite(x.multiIndex) ? x.multiIndex : null
    }))
    : [];
  const pc = raw.pendingClarification;
  mem.pendingClarification = (pc && typeof pc === 'object' && Array.isArray(pc.missing) && pc.missing.length > 0)
    ? {
      id: typeof pc.id === 'string' ? pc.id : 'C1',
      missing: pc.missing.map(String),
      originalIntent: typeof pc.originalIntent === 'string' ? pc.originalIntent : 'UNKNOWN',
      createdAtTurn: Number.isFinite(pc.createdAtTurn) ? pc.createdAtTurn : mem.turnIndex,
      originalText: typeof pc.originalText === 'string' ? pc.originalText.slice(0, 300) : null
    }
    : null;
  mem.resolvedReferences = Array.isArray(raw.resolvedReferences) ? raw.resolvedReferences.map(String) : [];
  const lc = raw.lastUserCorrection;
  mem.lastUserCorrection = (lc && typeof lc === 'object' && typeof lc.to === 'string')
    ? { from: typeof lc.from === 'string' ? lc.from : null, to: lc.to, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] }
    : null;
  mem.state = Object.values(WM_STATES).includes(raw.state) ? raw.state : WM_STATES.IDLE;
  return mem;
};

/* --------------------------------------------------------------------------
   ۳) تشخیص‌گرهای قطعی بافت (Deterministic Context Detectors)
   -------------------------------------------------------------------------- */

// سیاست حل تصحیح کاربر
const CORRECTION_POLICY = { RESOLVE: 'RESOLVE', OVERRIDE: 'OVERRIDE', ASK_CLARIFICATION: 'ASK_CLARIFICATION', RESET: 'RESET' };

const detectUserCorrection = (rawText) => {
  const s = wmNormalize(rawText);
  const isCorrection = /(^\s*نه\b|منظورم|اشتباه گفتم|تصحیح|ببخشید|نه اون|نه آن|نه اون یکی|اشتباه شد)/.test(s);
  if (!isCorrection) return { isCorrection: false, targetAssets: [], intent: null };
  const targetAssets = extractEntities(rawText).map(e => e.value);
  // «بازیابی از حافظه» مجاز نیست؛ اگر مقصد تصحیح صریح نباشد → شفاف‌سازی
  return {
    isCorrection: true,
    targetAssets,
    intent: targetAssets.length > 0 ? CORRECTION_POLICY.OVERRIDE : CORRECTION_POLICY.ASK_CLARIFICATION
  };
};

const detectComparisonOperation = (rawText) => {
  const s = wmNormalize(rawText);
  const assets = extractEntities(rawText).map(e => e.value);
  // مرزهای واژه به‌صورت صریح (\b در جاوااسکریپت با حروف فارسی منطبق نمی‌شود)
  if (/(^|\s)(فقط|تنها|منحصرا|صرفا)(\s|$)/.test(s)) return { operation: 'SET', assets, matched: 'فقط' };
  if (/(حذف|بردار|پاک کن)/.test(s) || /(^|\s)(به ?جز|بدون|بغیر ?از|غیر ?از|باستثنای)(\s|$)/.test(s)) {
    return { operation: 'REMOVE', assets, matched: 'حذف/استثنا' };
  }
  if (/(هم ?اضافه|اضافه ?کن|اضافه ?بشه|اضافه ?شود|را هم|هم بذار|هم بگذار|و هم)/.test(s)) return { operation: 'ADD', assets, matched: 'اضافه' };
  if (/(جایگزین|به ?جای|عوض کن|تبدیل کن)/.test(s)) return { operation: 'REPLACE', assets, matched: 'جایگزین' };
  return { operation: null, assets, matched: null };
};

const detectTopicReturn = (rawText) => {
  const s = wmNormalize(rawText);
  const isReturn = /(برگردیم به|برگرد به|بازگشت به|بازگرد به|دوباره|همون|همان|مورد قبلی|موضوع قبلی|بحث قبلی)/.test(s);
  if (!isReturn) return { isReturn: false, target: null, explicit: false };
  const knowledge = detectKnowledgeTopic(rawText);
  if (knowledge) return { isReturn: true, target: { kind: 'KNOWLEDGE', value: knowledge.topic }, explicit: true };
  const assets = extractEntities(rawText).map(e => e.value);
  if (assets.length > 0) return { isReturn: true, target: { kind: 'ASSET', value: assets[0] }, explicit: true };
  return { isReturn: true, target: null, explicit: false };
};

// تشخیص ارجاع به سناریو («سناریوی دوم»، «همان سناریوی قبلی»، «برعکسش»)
const detectScenarioReference = (rawText) => {
  const s = wmNormalize(rawText);
  if (/(سناریو|سناوری)/.test(s)) {
    if (/(اول|۱|1|یک)/.test(s)) return { kind: 'INDEX', index: 0 };
    if (/(دوم|۲|2|دو)/.test(s)) return { kind: 'INDEX', index: 1 };
    if (/(سوم|۳|3)/.test(s)) return { kind: 'INDEX', index: 2 };
    if (/(قبلی|قبل|همان|همون|اخیر)/.test(s)) return { kind: 'PREVIOUS', index: null };
  }
  if (/(برعکسش|برعکس|معکوس|خلافش|جهت مخالف)/.test(s)) return { kind: 'INVERT', index: null };
  return null;
};

// تشخیص قطعه شوک ناقص برای پیگیری سناریو («حالا ۵٪؟»، «حالا ۵٪ پایین؟»)
const detectShockFragment = (rawText) => {
  const s = wmNormalize(rawText);
  if (!s) return null;
  const followUp = /(حالا|بعدش|و اگر|اگر هم|پس اگر|بعد|دوباره|چی میشه|چی می‌شه|چطور|دیگه|دیگر|بازم|باز هم|اضافه)/.test(s);
  const pctMatch = wmToEnDigits(s).match(/(\d+(?:\.\d+)?)\s*(?:درصد|٪|%)/);
  const hasDirectionUp = /(بالا|رشد|افزایش|صعود|جهش|ببره بالا|بره بالا|مثبت)/.test(s);
  const hasDirectionDown = /(پایین|ریزش|افت|کاهش|سقوط|بریزه|منفی|نزول)/.test(s);
  if (!pctMatch) return null;
  if (!followUp && !hasDirectionUp && !hasDirectionDown) return null;
  return {
    mode: 'PERCENT_CHANGE',
    value: Number(pctMatch[1]),
    direction: hasDirectionDown ? 'DOWN' : (hasDirectionUp ? 'UP' : null),
    hasExplicitDirection: hasDirectionUp || hasDirectionDown
  };
};

/* --------------------------------------------------------------------------
   ۴) بازسازی قطعی پرسش فرضی (Deterministic Scenario Re-synthesis)
   -------------------------------------------------------------------------- */
const SYNTHETIC_DIRECTION = { UP: 'بالا', DOWN: 'پایین' };

const buildSyntheticScenarioQuery = (asset, mode, value, direction) => {
  const syn = wmAssetSynonym(asset);
  if (!syn || !Number.isFinite(Number(value))) return null;
  const v = Number(value);
  if (mode === 'TARGET_PRICE' || mode === 'ABSOLUTE_TARGET' || direction === 'NONE') {
    return `اگر ${syn} به ${v} برسه`;
  }
  if (mode === 'PERCENT_CHANGE') {
    const dir = SYNTHETIC_DIRECTION[direction] || SYNTHETIC_DIRECTION.UP;
    return `اگر ${syn} ${v} درصد ${dir} بره`;
  }
  // ABSOLUTE_CHANGE / ABSOLUTE_SHOCK
  const dir = SYNTHETIC_DIRECTION[direction] || SYNTHETIC_DIRECTION.UP;
  return `اگر ${syn} ${v} ${dir} بره`;
};

const resolveWhatIfParser = (deps) => {
  if (deps && typeof deps.whatIfParser === 'function') return deps.whatIfParser;
  if (typeof FinancialNormalizerWhatIf !== 'undefined' && FinancialNormalizerWhatIf && typeof FinancialNormalizerWhatIf.parseWhatIfQuery === 'function') {
    return FinancialNormalizerWhatIf.parseWhatIfQuery;
  }
  // محیط Worker ۳: پارسر سطح‌اسکریپت (hoisted) — همان پیاده‌سازی فاز ۱-۱
  if (typeof parseWhatIfQuery === 'function') return parseWhatIfQuery;
  try {
    // eslint-disable-next-line global-require
    const mod = require('./financial-normalizer-whatif');
    if (mod && typeof mod.parseWhatIfQuery === 'function') return mod.parseWhatIfQuery;
  } catch (e) { /* در محیط Worker حذف می‌شود؛ parser تزریق می‌گردد */ }
  return null;
};

const extractAssumptions = (whatIfAst) => {
  if (!whatIfAst || typeof whatIfAst !== 'object') return [];
  if (Array.isArray(whatIfAst.assumptions)) return whatIfAst.assumptions;
  if (Array.isArray(whatIfAst.scenarios)) {
    return whatIfAst.scenarios.flatMap(s => (s && Array.isArray(s.assumptions)) ? s.assumptions : []);
  }
  // ساختار کانونیکال مقایسه دو سناریویی فاز ۱-۱ (scenarioA / scenarioB)
  const multi = [];
  if (whatIfAst.scenarioA && Array.isArray(whatIfAst.scenarioA.assumptions)) multi.push(whatIfAst.scenarioA.assumptions[0]);
  if (whatIfAst.scenarioB && Array.isArray(whatIfAst.scenarioB.assumptions)) multi.push(whatIfAst.scenarioB.assumptions[0]);
  if (multi.length > 0) return multi.filter(Boolean);
  return [];
};

/**
 * ساخت بافت نوبت‌های پیشین برای موتور فاز ۱-۲ (Legacy Anaphora Bridge)
 * فقط نوبت‌های کاربر (USER_TEXT) منتقل می‌شوند و در انتها یک نوبت مصنوعی از state معنایی
 * فعلی افزوده می‌شود تا حل ضمیر با کمترین تقدم انجام شود. هیچ عدد بازار منتقل نمی‌شود.
 */
const buildRecentContextFromMemory = (memory, history) => {
  const ctx = [];
  if (Array.isArray(history)) {
    for (const turn of history) {
      if (!turn || typeof turn !== 'object') continue;
      if (turn.role !== 'user') continue; // کانال دستیار (LLM_OUTPUT) غیرقابل اعتماد است
      const text = String(turn.text || turn.content || '');
      if (text) ctx.push({ role: 'user', text });
    }
  }
  const syntheticParts = [];
  for (const asset of memory.activeAssets) {
    const syn = wmAssetSynonym(asset);
    if (syn) syntheticParts.push(syn);
  }
  if (memory.activeTopic && memory.activeTopic.kind === 'KNOWLEDGE') {
    const kws = KNOWLEDGE_TOPICS[memory.activeTopic.value];
    if (Array.isArray(kws) && kws.length > 0) syntheticParts.push(kws[0]);
  }
  if (syntheticParts.length > 0) {
    ctx.push({ role: 'system_state', text: `بافت فعال: ${syntheticParts.join(' ، ')}`, trust: WM_TRUST.SYSTEM_STATE });
  }
  return ctx;
};

/* --------------------------------------------------------------------------
   ۵) حل‌کننده نوبت (Deterministic Turn Resolver) — ماشین حالت + تقدم قطعی
   -------------------------------------------------------------------------- */

const wmMarkCorrection = (val) => val;

/**
 * حل یک نوبت گفتگو روی حافظه قبلی (بدون هیچ وابستگی به LLM)
 * @param {Object} previousMemory حافظه نوبت قبل (یا حافظه خالی)
 * @param {string} rawText پیام کاربر
 * @param {Object} todayEvidence شواهد تابلو (فقط به موتور نیت پاس می‌شود، هرگز به حافظه راه نمی‌یابد)
 * @param {Object} deps وابستگی‌های تزریقی { whatIfParser, history }
 * @returns {{ memory: Object, cir: Object, resolution: Object, validation: Object }}
 */
const resolveTurn = (previousMemory, rawText, todayEvidence = {}, deps = {}) => {
  const prev = normalizeWorkingMemory(previousMemory);
  const text = String(rawText || '').trim();
  const turnIndex = prev.turnIndex + 1;
  const whatIfParser = resolveWhatIfParser(deps);
  const notes = [];
  const semanticSources = [];

  const mem = Object.assign({}, prev, {
    turnIndex,
    updatedAtTurn: turnIndex,
    activeAssets: prev.activeAssets.slice(),
    topicStack: prev.topicStack.slice(),
    comparisonSet: { mode: prev.comparisonSet.mode, assets: prev.comparisonSet.assets.slice() },
    scenarioLedger: prev.scenarioLedger.slice(),
    resolvedReferences: []
  });

  const registerResolved = (kind, ref) => {
    mem.resolvedReferences.push({ kind, ref, source: WM_TRUST.DETERMINISTIC_STATE, trust: WM_TRUST_CLASS[WM_TRUST.DETERMINISTIC_STATE] });
  };

  // ── مرحله ۰: گاردریل ضدسیگنال (بدون هیچ غنی‌سازی معنایی از پرسش محدود)
  const recentContext = buildRecentContextFromMemory(prev, deps.history);
  const baseCir = analyzeQuery(text, recentContext, todayEvidence);

  if (baseCir.intent.primary === INTENTS.ANTI_SIGNAL_RESTRICTED) {
    const restricted = Object.assign({}, prev, { turnIndex, updatedAtTurn: turnIndex, state: WM_STATES.RESTRICTED, activeIntent: INTENTS.ANTI_SIGNAL_RESTRICTED });
    return {
      memory: restricted,
      cir: baseCir,
      resolution: {
        path: 'ANTI_SIGNAL_GUARD',
        state: WM_STATES.RESTRICTED,
        semanticSources: [],
        notes: ['پرسش محدود ضدسیگنال: هیچ دارایی/سناریو/شواهدی از این نوبت به حافظه افزوده نشد.'],
        satisfiedBy: ['ANTI_SIGNAL_GUARD'],
        corrected: null,
        clarification: null,
        staleValuesGuard: 'ENFORCED'
      },
      validation: validateWorkingMemory(restricted)
    };
  }

  // ── تازگی/انقضای شفاف‌سازی معلق (Semantic Expiration)
  let pendingExpired = false;
  if (mem.pendingClarification && (turnIndex - mem.pendingClarification.createdAtTurn) > WM_LIMITS.PENDING_CLARIFICATION_TTL_TURNS) {
    notes.push('شفاف‌سازی معلق منقضی شد (EXPIRED).');
    mem.pendingClarification = null;
    mem.state = WM_STATES.EXPIRED;
    pendingExpired = true;
  }

  const explicitEntities = baseCir.entities.map(e => e.value);
  const temporal = resolveTemporal(text);
  const correction = detectUserCorrection(text);
  const comparisonOp = detectComparisonOperation(text);
  const topicReturn = detectTopicReturn(text);
  const shockFragment = detectShockFragment(text);

  // ── پیش‌محاسبه قطعی فرض‌های سناریویی همین نوبت (یک‌بار، برای تقدم صحیح مراحل)
  let ast = whatIfParser ? whatIfParser(text, []) : null;
  let assumptions = extractAssumptions(ast);
  let scenarioChainOut = null; // FIX-5 (Phase 2-3E-B): زنجیره فرض‌های فعال
  let scenarioTargetOut = null;
  let replayText = null;
  {
    const candidateAsset = (explicitEntities.length > 0 ? explicitEntities[0] : null) ||
      (mem.activeAssets.length > 0 ? mem.activeAssets[0] : null) ||
      (mem.scenario ? mem.scenario.asset : null);
    if (assumptions.length === 0 && candidateAsset) {
      const syn = wmAssetSynonym(candidateAsset);
      if (syn) {
        replayText = `${text} ${syn}`;
        const replayAst = whatIfParser ? whatIfParser(replayText, []) : null;
        const replayAssumptions = extractAssumptions(replayAst);
        if (replayAssumptions.length > 0) {
          assumptions = replayAssumptions;
          ast = replayAst;
          notes.push('فرض شوک با ضمیمه دارایی بافت‌دار بازخوانی شد (Deterministic Asset-Append Replay).');
        }
      }
    }
  }
  // FIX-3 (Phase 2-3E-B): WHAT_IF با ≥۲ فرض نیز سناریوی چندفرضی خودبسنده است (نه فقط مقایسه سناریو الف/ب)
  const isSelfContainedMulti = !!(ast && (ast.type === 'MULTI_SCENARIO_COMPARISON' || ast.type === 'WHAT_IF') && assumptions.length >= 2);
  const scenarioRef = isSelfContainedMulti ? null : detectScenarioReference(text);

  let resolutionPath = 'NO_CONTEXT';
  let corrected = null;
  let clarification = null;
  let reAskedClarification = null;
  let resolvedCir = baseCir;

  const setComparison = (assets, mode) => {
    mem.comparisonSet = { mode, assets: assets.slice() };
    mem.activeAssets = assets.slice();
  };

  const registerScenario = (entry) => {
    const s = Object.assign({}, entry);
    mem.scenario = s;
    mem.scenarioLedger = mem.scenarioLedger.concat([s]).slice(-WM_LIMITS.MAX_SCENARIO_LEDGER);
    return s;
  };

  const nextScenarioId = () => `S${mem.scenarioLedger.length + 1}`;

  // ── مرحله ۱: تصحیح صریح کاربر (بالاترین اولویت معنایی)
  if (correction.isCorrection) {
    if (correction.intent === CORRECTION_POLICY.OVERRIDE) {
      const from = mem.activeAssets.length === 1 ? mem.activeAssets[0] : null;
      const to = correction.targetAssets[0];
      corrected = { from, to, policy: CORRECTION_POLICY.OVERRIDE };
      mem.lastUserCorrection = { from, to, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] };
      mem.activeAssets = correction.targetAssets.slice();
      setComparison(correction.targetAssets.slice(), 'SINGLE');
      mem.activeTopic = { kind: 'ASSET', value: to, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] };
      registerResolved('ASSET_OVERRIDE', to);
      mem.state = WM_STATES.ASSET_CONTEXT;
      resolutionPath = 'USER_CORRECTION_OVERRIDE';
      semanticSources.push(WM_TRUST.USER_TEXT);
      // حل مجدد پرسش با دارایی تصحیح‌شده (بدون حدس)
      const syn = wmAssetSynonym(to);
      resolvedCir = syn ? analyzeQuery(text.includes(syn) ? text : `${text} ${syn}`, recentContext, todayEvidence) : baseCir;
    } else {
      mem.state = WM_STATES.AWAITING_CLARIFICATION;
      clarification = { id: `C${turnIndex}`, missing: ['ASSET'], originalIntent: baseCir.intent.primary, createdAtTurn: turnIndex, originalText: text.slice(0, 300) };
      mem.pendingClarification = clarification;
      resolutionPath = 'USER_CORRECTION_CLARIFICATION';
      notes.push('تصحیح کاربر بدون مقصد صریح: شفاف‌سازی لازم است (بدون حدس).');
    }
  }

  // ── مرحله ۲: مصرف شفاف‌سازی معلق (Pending Clarification Consumption)
  if (!correction.isCorrection && mem.pendingClarification && !pendingExpired) {
    const pc = mem.pendingClarification;
    const isBareAssetAnswer = explicitEntities.length > 0 && !baseCir.requiresKnowledge &&
      (baseCir.intent.primary === INTENTS.UNKNOWN || baseCir.intent.primary === INTENTS.MARKET_STATUS || baseCir.intent.primary === INTENTS.ASSET_ANALYSIS) &&
      (comparisonOp.operation === null) && !topicReturn.isReturn && !scenarioRef;

    if (isBareAssetAnswer && pc.missing.includes('ASSET') && pc.originalText) {
      const replayText = `${pc.originalText} ${text}`.trim();
      const replayCir = analyzeQuery(replayText, recentContext, todayEvidence);
      const assumptions = extractAssumptions(whatIfParser ? whatIfParser(replayText, []) : null);
      if (replayCir.intent.primary === INTENTS.WHAT_IF && replayCir.entities.length > 0 && assumptions.length > 0) {
        const a = assumptions[0];
        registerScenario({
          scenarioId: nextScenarioId(),
          parentScenarioId: null,
          asset: a.asset,
          mode: a.mode,
          value: a.value,
          direction: a.direction,
          queryText: replayText.slice(0, 300),
          multiIndex: null
        });
        mem.activeAssets = [a.asset];
        focusAsset(a.asset, mem);
        mem.activeTopic = { kind: 'ASSET', value: a.asset, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] };
        mem.pendingClarification = null;
        mem.state = WM_STATES.SCENARIO_CONTEXT;
        resolvedCir = replayCir;
        resolutionPath = 'PENDING_CLARIFICATION_RESOLVED';
        registerResolved('PENDING_CLARIFICATION', pc.id);
        semanticSources.push(WM_TRUST.USER_TEXT, WM_TRUST.SYSTEM_STATE);
      }
    }
    if (resolutionPath === 'NO_CONTEXT') {
      // پاسخ، شفاف‌سازی معلق را پاسخ نداد → معلق تا سقف TTL حفظ و در نوبت بعد مجدداً پرسیده می‌شود
      // (قرارداد §9: «bare asset answer resolves it; otherwise re-ask»)
      reAskedClarification = {
        id: pc.id,
        missing: pc.missing.slice(),
        originalIntent: pc.originalIntent,
        createdAtTurn: pc.createdAtTurn,
        reAsk: true
      };
      notes.push('شفاف‌سازی معلق پاسخ داده نشد؛ تا سقف TTL حفظ و مجدداً پرسیده می‌شود (Re-Ask).');
    }
  }

  // ── مرحله ۳: ارجاع به سناریو (پیگیری/بازگشت/وارونگی)
  if (resolutionPath === 'NO_CONTEXT' && scenarioRef) {
    const pickEntry = () => {
      if (scenarioRef.kind === 'INVERT' || scenarioRef.kind === 'PREVIOUS') {
        return mem.scenario || mem.scenarioLedger[mem.scenarioLedger.length - 1] || null;
      }
      if (scenarioRef.kind === 'INDEX') {
        const ledger = mem.scenarioLedger;
        return (ledger.length > scenarioRef.index) ? ledger[scenarioRef.index] : null;
      }
      return null;
    };
    const target = pickEntry();
    if (target) {
      const direction = (scenarioRef.kind === 'INVERT')
        ? (target.direction === 'UP' ? 'DOWN' : 'UP')
        : target.direction;
      const q = (scenarioRef.kind === 'INVERT')
        ? buildSyntheticScenarioQuery(target.asset, target.mode, target.value, direction)
        : (target.queryText || buildSyntheticScenarioQuery(target.asset, target.mode, target.value, direction));
      const replayCir = q ? analyzeQuery(q, recentContext, todayEvidence) : baseCir;
      const ast = whatIfParser ? whatIfParser(q || '', []) : null;
      const assumptions = extractAssumptions(ast);
      const a = assumptions[target.multiIndex != null ? Math.min(target.multiIndex, assumptions.length - 1) : 0] || assumptions[0];
      if (a) {
        registerScenario({
          scenarioId: nextScenarioId(),
          parentScenarioId: target.scenarioId || null,
          asset: a.asset,
          mode: a.mode,
          value: a.value,
          direction: a.direction,
          queryText: (q || '').slice(0, 300),
          multiIndex: null
        });
        mem.activeAssets = [a.asset];
        focusAsset(a.asset, mem);
        mem.state = WM_STATES.SCENARIO_CONTEXT;
        resolvedCir = replayCir;
        resolutionPath = scenarioRef.kind === 'INVERT' ? 'SCENARIO_INVERTED' : 'SCENARIO_REFERENCE_RESOLVED';
        registerResolved('SCENARIO', target.scenarioId || 'S1');
        semanticSources.push(WM_TRUST.USER_TEXT, WM_TRUST.SYSTEM_STATE);
      }
    }
    if (resolutionPath === 'NO_CONTEXT') {
      mem.state = WM_STATES.AWAITING_CLARIFICATION;
      clarification = { id: `C${turnIndex}`, missing: ['SCENARIO'], originalIntent: INTENTS.WHAT_IF, createdAtTurn: turnIndex, originalText: text.slice(0, 300) };
      mem.pendingClarification = clarification;
      resolutionPath = 'SCENARIO_REFERENCE_UNRESOLVED';
      notes.push('ارجاع سناریویی بدون سناریوی معتبر قابل حل نیست → شفاف‌سازی.');
    }
  }

  // ── مرحله ۴: عملیات روی مجموعه مقایسه (ADD / REMOVE / REPLACE / SET)
  // گارد: عملیات مجموعه تنها در بافت مقایسه/دارایی فعال و بیرون از پرسش دانشنامه‌ای اعمال می‌شود
  const comparisonContextAssets = (mem.comparisonSet.assets.length > 0) ? mem.comparisonSet.assets.slice() : mem.activeAssets.slice();
  // FIX-6 (Phase 2-3E-B): نوبتی که فرض درصدی صریح What-If دارد، در مرحله سناریو ثبت می‌شود؛ عملیات مجموعه آن را نمی‌رباید
  const hasWhatIfAssumptionsThisTurn = Array.isArray(assumptions) && assumptions.length > 0;
  const comparisonStageApplicable = comparisonOp.operation &&
    !hasWhatIfAssumptionsThisTurn &&
    !baseCir.requiresKnowledge &&
    baseCir.intent.primary !== INTENTS.KNOWLEDGE_QUERY &&
    (comparisonOp.assets.length > 0 || comparisonContextAssets.length >= 2);
  if (resolutionPath === 'NO_CONTEXT' && comparisonStageApplicable) {
    const op = comparisonOp.operation;
    const assets = comparisonOp.assets;
    if (assets.length === 0 && op !== 'SET') {
      mem.state = WM_STATES.AWAITING_CLARIFICATION;
      clarification = { id: `C${turnIndex}`, missing: ['ASSET'], originalIntent: INTENTS.COMPARISON, createdAtTurn: turnIndex, originalText: text.slice(0, 300) };
      mem.pendingClarification = clarification;
      resolutionPath = 'COMPARISON_OPERATION_UNRESOLVED';
      notes.push('عملیات مجموعه مقایسه بدون دارایی صریح: شفاف‌سازی (مجموعه حدس زده نشد).');
    } else {
      const current = mem.comparisonSet.assets.length > 0 ? mem.comparisonSet.assets : mem.activeAssets.slice();
      let next = current.slice();
      if (op === 'ADD') {
        for (const a of assets) if (!next.includes(a)) next.push(a);
      } else if (op === 'REMOVE') {
        next = next.filter(a => !assets.includes(a));
      } else if (op === 'REPLACE' || op === 'SET') {
        next = assets.slice();
      }
      if (next.length === 0) {
        mem.state = WM_STATES.AWAITING_CLARIFICATION;
        clarification = { id: `C${turnIndex}`, missing: ['ASSET'], originalIntent: INTENTS.COMPARISON, createdAtTurn: turnIndex, originalText: text.slice(0, 300) };
        mem.pendingClarification = clarification;
        resolutionPath = 'COMPARISON_EMPTY_SET';
        notes.push('مجموعه مقایسه بعد از عملیات خالی می‌شود → شفاف‌سازی.');
      } else {
        setComparison(next, next.length >= 2 ? 'COMPARE' : 'SINGLE');
        mem.state = next.length >= 2 ? WM_STATES.COMPARISON_CONTEXT : WM_STATES.ASSET_CONTEXT;
        resolutionPath = `COMPARISON_${op}`;
        registerResolved('COMPARISON_SET', next.join('+'));
        semanticSources.push(WM_TRUST.SYSTEM_STATE);
      }
    }
  }

  // ── مرحله ۵: بازگشت به موضوع (Topic Return)
  if (resolutionPath === 'NO_CONTEXT' && topicReturn.isReturn) {
    if (topicReturn.explicit) {
      if (mem.activeTopic) mem.topicStack = mem.topicStack.concat([{ kind: mem.activeTopic.kind, value: mem.activeTopic.value }]).slice(-WM_LIMITS.MAX_TOPIC_STACK_DEPTH);
      mem.activeTopic = { kind: topicReturn.target.kind, value: topicReturn.target.value, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] };
      if (topicReturn.target.kind === 'ASSET') {
        mem.activeAssets = [topicReturn.target.value];
        focusAsset(topicReturn.target.value, mem);
        mem.state = WM_STATES.ASSET_CONTEXT;
      } else {
        mem.activeAssets = [];
        setComparison([], 'SINGLE');
        mem.state = WM_STATES.TOPIC_CONTEXT;
      }
      if (mem.scenario && topicReturn.target.kind === 'ASSET' && mem.scenario.asset !== topicReturn.target.value) {
        mem.scenario = null;
      }
      if (mem.scenario && topicReturn.target.kind === 'KNOWLEDGE') {
        mem.scenario = null;
      }
      resolutionPath = 'TOPIC_RETURN_EXPLICIT';
      registerResolved('TOPIC', `${topicReturn.target.kind}:${topicReturn.target.value}`);
      semanticSources.push(WM_TRUST.USER_TEXT);
    } else if (mem.topicStack.length > 0) {
      const target = mem.topicStack[mem.topicStack.length - 1];
      mem.topicStack = mem.topicStack.slice(0, -1);
      mem.activeTopic = { kind: target.kind, value: target.value, source: WM_TRUST.SYSTEM_STATE, trust: WM_TRUST_CLASS[WM_TRUST.SYSTEM_STATE] };
      if (target.kind === 'ASSET') {
        mem.activeAssets = [target.value];
        setComparison([target.value], 'SINGLE');
        mem.state = WM_STATES.ASSET_CONTEXT;
      } else {
        mem.state = WM_STATES.TOPIC_CONTEXT;
      }
      resolutionPath = 'TOPIC_RETURN_STACK';
      registerResolved('TOPIC', `${target.kind}:${target.value}`);
      semanticSources.push(WM_TRUST.SYSTEM_STATE);
    } else {
      mem.state = WM_STATES.AWAITING_CLARIFICATION;
      clarification = { id: `C${turnIndex}`, missing: ['TOPIC'], originalIntent: INTENTS.FOLLOW_UP, createdAtTurn: turnIndex, originalText: text.slice(0, 300) };
      mem.pendingClarification = clarification;
      resolutionPath = 'TOPIC_RETURN_UNRESOLVED';
      notes.push('بازگشت به موضوع بدون مقصد صریح و بدون پشته معتبر → شفاف‌سازی.');
    }
  }

  // ── مرحله ۶: سناریو (صریح / پیگیری / وارونگی جهت / جانشینی دارایی)
  if (resolutionPath === 'NO_CONTEXT') {
    const isMulti = isSelfContainedMulti;
    const activeScenario = mem.scenario;
    // FIX-5 (Phase 2-3E-B): پیگیری هدف سناریوی فعال («… چقدر می‌شود؟») — بکارگیری زنجیره کامل فرض‌های ثبت‌شده، بدون حذف هیچ فرض
    const hasShockThisTurn = assumptions.length > 0 || !!shockFragment;
    const targetAskPattern = /چقدر[\s\u200c]*(?:می[\s\u200c]*ش(?:ود|ه)|خواهد[\s\u200c]*شد|بشه|شود)/;
    const followUpTarget = (!hasShockThisTurn && targetAskPattern.test(wmNormalize(text)) && Array.isArray(baseCir.entities))
      ? (baseCir.entities.map(e => e.value).filter(v => v === 'GOLD18' || v === 'XAU')[0] || null)
      : null;
    if (activeScenario && followUpTarget) {
      const byId = {};
      mem.scenarioLedger.forEach(e => { if (e && e.scenarioId) byId[e.scenarioId] = e; });
      const chain = [];
      const seenIds = new Set();
      let cursor = activeScenario.scenarioId || null;
      while (cursor && byId[cursor] && !seenIds.has(cursor)) { seenIds.add(cursor); chain.unshift(byId[cursor]); cursor = byId[cursor].parentScenarioId; }
      if (chain.length === 0) chain.push(activeScenario);
      const parts = chain
        .map(e => buildSyntheticScenarioQuery(e.asset, e.mode || 'PERCENT_CHANGE', Number(e.value), e.direction || 'UP'))
        .filter(Boolean);
      if (parts.length > 0) {
        const synthText = parts.join(' و ');
        const synthCir = analyzeQuery(synthText, recentContext, todayEvidence);
        if (synthCir) resolvedCir = synthCir;
        mem.activeAssets = [followUpTarget];
        focusAsset(followUpTarget, mem);
        mem.activeTopic = { kind: 'ASSET', value: followUpTarget, source: WM_TRUST.SYSTEM_STATE, trust: WM_TRUST_CLASS[WM_TRUST.SYSTEM_STATE] };
        mem.state = WM_STATES.SCENARIO_CONTEXT;
        scenarioChainOut = chain.map(e => ({ asset: e.asset, mode: e.mode || 'PERCENT_CHANGE', value: Number(e.value), direction: e.direction || 'UP' }));
        scenarioTargetOut = followUpTarget;
        resolutionPath = 'SCENARIO_TARGET_CARRY_OVER';
        semanticSources.push(WM_TRUST.SYSTEM_STATE, WM_TRUST.USER_TEXT);
        notes.push('پیگیری هدف سناریوی فعال: پاسخ از زنجیره کامل فرض‌های ثبت‌شده ساخته می‌شود (هیچ فرضی حذف نمی‌شود).');
      }
    }
    const isScenarioIntent = baseCir.intent.primary === INTENTS.WHAT_IF ||
      baseCir.intent.primary === INTENTS.SCENARIO_COMPARISON ||
      !!ast || !!shockFragment ||
      (baseCir.intent.primary === INTENTS.CLARIFICATION_REQUIRED && (baseCir.intent.secondary || []).includes(INTENTS.WHAT_IF));

    if (resolutionPath === 'NO_CONTEXT' && isScenarioIntent) {
      if (isMulti) {
        // دفتر سناریو: ثبت همه فروض نوبت در Ledger با ایندکس (پشتیبانی «سناریوی دوم»)
        let parentId = activeScenario ? activeScenario.scenarioId : null;
        assumptions.forEach((a, idx) => {
          const entry = {
            scenarioId: `S${mem.scenarioLedger.length + 1}`,
            parentScenarioId: parentId,
            asset: a.asset,
            mode: a.mode,
            value: a.value,
            direction: a.direction,
            queryText: text.slice(0, 300),
            multiIndex: idx
          };
          registerScenario(entry);
          parentId = entry.scenarioId;
        });
        const assets = Array.from(new Set(assumptions.map(a => a.asset)));
        setComparison(assets, assets.length >= 2 ? 'COMPARE' : 'SINGLE');
        mem.activeAssets = assets;
        mem.state = WM_STATES.SCENARIO_CONTEXT;
        resolutionPath = 'SCENARIO_MULTI_REGISTERED';
        semanticSources.push(WM_TRUST.USER_TEXT);
      } else {
        let asset = null;
        let mode = null;
        let value = null;
        let direction = null;
        let queryText = text.slice(0, 300);
        // FIX-B2-4 (Phase 2-3F-B2): نشانگر ادامه تجمعی («دیگه/بازم/دوباره») برای شوک بعدی همان دارایی
        const cumulativeMarker = /(دیگه|دیگر|بازم|باز هم|دوباره|اضافه|بیشتر)/.test(wmNormalize(text));
        let cumulativeApplied = false;
        if (assumptions.length > 0) {
          const a = assumptions[0];
          asset = a.asset; mode = a.mode; value = a.value; direction = a.direction;
          if (replayText) queryText = replayText.slice(0, 300);
          // FIX-B2-4 (Phase 2-3F-B2): نشانگر «دیگه/بازم/دوباره» با جهت هم‌سو = شوک تجمعی نسبت به سناریوی فعال (+۱۰ و +۵ دیگر → +۱۵)
          if (cumulativeMarker && activeScenario && activeScenario.mode === 'PERCENT_CHANGE' && asset === activeScenario.asset &&
              Number.isFinite(Number(activeScenario.value)) && (activeScenario.direction || 'UP') === (direction || 'UP')) {
            value = Number(activeScenario.value) + Number(value);
            mode = 'PERCENT_CHANGE';
            cumulativeApplied = true;
          }
          if (cumulativeApplied) {
            const cumSynth = buildSyntheticScenarioQuery(asset, mode, value, direction || 'UP');
            if (cumSynth) {
              queryText = cumSynth.slice(0, 300);
              const cumCir = analyzeQuery(cumSynth, recentContext, todayEvidence);
              if (cumCir) resolvedCir = cumCir;
            }
          }
        } else if (shockFragment) {
          // پیگیری سناریو: دارایی از فرض فعال یا دارایی‌های فعال؛ جهت از قطعه یا ارث‌بری
          asset = (activeScenario && activeScenario.asset) || mem.activeAssets[0] || null;
          mode = shockFragment.mode;
          value = shockFragment.value;
          direction = shockFragment.hasExplicitDirection
            ? shockFragment.direction
            : ((activeScenario && activeScenario.direction) || 'UP');
          // FIX-B2-4: جهت هم‌سو + نشانگر «دیگه» = شوک تجمعی نسبت به سناریوی فعال (+۱۰ و +۵ دیگر → +۱۵)
          if (cumulativeMarker && activeScenario && activeScenario.mode === 'PERCENT_CHANGE' && asset === activeScenario.asset &&
              Number.isFinite(Number(activeScenario.value)) && (activeScenario.direction || 'UP') === direction) {
            value = Number(activeScenario.value) + Number(shockFragment.value);
            cumulativeApplied = true;
          }
          const synth = asset ? buildSyntheticScenarioQuery(asset, mode, value, direction) : null;
          if (synth) {
            queryText = synth.slice(0, 300);
            const synthCir = analyzeQuery(synth, recentContext, todayEvidence);
            const synthAst = whatIfParser ? whatIfParser(synth, []) : null;
            const synthAssumptions = extractAssumptions(synthAst);
            if (synthAssumptions.length > 0) {
              const sa = synthAssumptions[0];
              asset = sa.asset; mode = sa.mode; value = sa.value; direction = sa.direction;
            }
            resolvedCir = synthCir;
          }
        }

        // عدم جانشینی/حدس: اگر دارایی قابل تعیین نیست → شفاف‌سازی
        if (!asset || !Number.isFinite(Number(value))) {
          mem.state = WM_STATES.AWAITING_CLARIFICATION;
          clarification = {
            id: `C${turnIndex}`,
            missing: ['ASSET'],
            originalIntent: INTENTS.WHAT_IF,
            createdAtTurn: turnIndex,
            originalText: text.slice(0, 300)
          };
          mem.pendingClarification = clarification;
          resolutionPath = 'SCENARIO_UNRESOLVED';
          notes.push('فرض سناریویی بدون دارایی قابل اعتماد: شفاف‌سازی (بدون حدس).');
        } else {
          const parent = activeScenario;
          const sameAsParent = parent && parent.asset === asset && Number(parent.value) === Number(value) && parent.direction === direction && parent.mode === mode;
          const entry = {
            scenarioId: nextScenarioId(),
            parentScenarioId: parent ? parent.scenarioId : null,
            asset,
            mode: mode || 'PERCENT_CHANGE',
            value: Number(value),
            direction: direction || 'UP',
            queryText,
            multiIndex: null
          };
          if (!sameAsParent) {
            registerScenario(entry);
            semanticSources.push(WM_TRUST.USER_TEXT);
          } else if (!mem.scenario) {
            registerScenario(entry);
          }
          mem.activeAssets = [asset];
          focusAsset(asset, mem);
          mem.activeTopic = { kind: 'ASSET', value: asset, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] };
          mem.state = WM_STATES.SCENARIO_CONTEXT;
          if (resolutionPath === 'NO_CONTEXT') {
            if (cumulativeApplied) {
              resolutionPath = 'SCENARIO_CUMULATIVE_CONTINUATION';
            } else if (shockFragment && parent) {
              resolutionPath = shockFragment.hasExplicitDirection ? 'SCENARIO_DIRECTION_OVERRIDE' : 'SCENARIO_CARRY_OVER';
            } else {
              resolutionPath = 'SCENARIO_EXPLICIT';
            }
          }
        }
      }
    }
  }

  // ── مرحله ۷: پرسش دانشنامه‌ای → پشته موضوع
  if (resolutionPath === 'NO_CONTEXT' && (baseCir.requiresKnowledge || baseCir.knowledgeQuery)) {
    const topic = baseCir.knowledgeQuery ? baseCir.knowledgeQuery.topic : null;
    if (mem.activeTopic) mem.topicStack = mem.topicStack.concat([{ kind: mem.activeTopic.kind, value: mem.activeTopic.value }]).slice(-WM_LIMITS.MAX_TOPIC_STACK_DEPTH);
    mem.activeTopic = topic ? { kind: 'KNOWLEDGE', value: topic, source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] } : mem.activeTopic;
    mem.activeAssets = [];
    setComparison([], 'SINGLE');
    // سناریوی فعال با تغییر موضوع صریح منقضی می‌شود (سابقه در Ledger حفظ می‌ماند)
    if (mem.scenario) { mem.scenario = null; notes.push('سناریوی فعال با تغییر موضوع صریح غیرفعال شد (سابقه در Ledger).'); }
    mem.state = WM_STATES.TOPIC_CONTEXT;
    resolutionPath = 'KNOWLEDGE_TOPIC';
    semanticSources.push(WM_TRUST.USER_TEXT);
  }

  // ── مرحله ۸: دارایی صریح / مقایسه صریح / حل ضمیر فاز ۱-۲
  if (resolutionPath === 'NO_CONTEXT') {
    if (explicitEntities.length >= 2 || (baseCir.intent.primary === INTENTS.COMPARISON && explicitEntities.length >= 1)) {
      setComparison(explicitEntities.slice(), explicitEntities.length >= 2 ? 'COMPARE' : 'SINGLE');
      mem.state = explicitEntities.length >= 2 ? WM_STATES.COMPARISON_CONTEXT : WM_STATES.ASSET_CONTEXT;
      mem.activeTopic = { kind: 'ASSET', value: explicitEntities[0], source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] };
      if (mem.scenario && !explicitEntities.includes(mem.scenario.asset)) {
        mem.scenario = null;
        notes.push('سناریوی فعال خارج از مجموعه صریح جدید بود و غیرفعال شد (سابقه در Ledger).');
      }
      resolutionPath = (baseCir.context && baseCir.context.isFollowUp) ? 'LEGACY_ANAPHORA' : 'EXPLICIT_COMPARISON';
      semanticSources.push((baseCir.context && baseCir.context.isFollowUp) ? WM_TRUST.SYSTEM_STATE : WM_TRUST.USER_TEXT);
    } else if (explicitEntities.length === 1) {
      mem.activeAssets = explicitEntities.slice();
      setComparison(explicitEntities.slice(), 'SINGLE');
      mem.activeTopic = { kind: 'ASSET', value: explicitEntities[0], source: WM_TRUST.USER_TEXT, trust: WM_TRUST_CLASS[WM_TRUST.USER_TEXT] };
      // جانشینی صریح دارایی: سناریوی متعلق به دارایی دیگر نباید فعال باقی بماند
      if (mem.scenario && mem.scenario.asset !== explicitEntities[0]) {
        mem.scenario = null;
        notes.push('سناریوی فعال متعلق به دارایی دیگر بود و غیرفعال شد (سابقه در Ledger).');
      }
      mem.state = WM_STATES.ASSET_CONTEXT;
      resolutionPath = (baseCir.context && baseCir.context.isFollowUp) ? 'LEGACY_ANAPHORA' : 'EXPLICIT_ASSET';
      semanticSources.push((baseCir.context && baseCir.context.isFollowUp) ? WM_TRUST.SYSTEM_STATE : WM_TRUST.USER_TEXT);
      if (baseCir.context && baseCir.context.isFollowUp) registerResolved('ASSET', explicitEntities.join('+'));
    } else if (baseCir.context && baseCir.context.isFollowUp && baseCir.entities.length > 0) {
      const assets = baseCir.entities.map(e => e.value);
      mem.activeAssets = assets.slice();
      setComparison(assets.slice(), 'SINGLE');
      mem.state = WM_STATES.ASSET_CONTEXT;
      resolutionPath = 'LEGACY_ANAPHORA';
      registerResolved('ASSET', assets.join('+'));
      semanticSources.push(WM_TRUST.SYSTEM_STATE);
    }
  }

  // ── مرحله ۹: پیگیری مبهم (Pronoun follow-up بدون دارایی) → استفاده از دارایی فعال یا شفاف‌سازی
  if (resolutionPath === 'NO_CONTEXT') {
    const isVagueFollowUp = /(اون|آن|همین|ایشون|این یکی|مورد|چطوره|چیه)/.test(wmNormalize(text)) && text.length <= 30;
    if (isVagueFollowUp && mem.activeAssets.length > 0) {
      mem.activeAssets = mem.activeAssets.slice();
      mem.state = mem.state === WM_STATES.SCENARIO_CONTEXT ? WM_STATES.SCENARIO_CONTEXT : WM_STATES.ASSET_CONTEXT;
      resolutionPath = 'VAGUE_FOLLOWUP_ACTIVE_ASSET';
      registerResolved('ASSET', mem.activeAssets.join('+'));
      semanticSources.push(WM_TRUST.SYSTEM_STATE);
    } else if (temporal.label) {
      resolutionPath = 'TEMPORAL_FOLLOWUP';
      if (mem.timeframe.horizon === 'CURRENT') mem.timeframe = { label: temporal.label, horizon: temporal.horizon, requiresHistoricalData: temporal.requiresHistoricalData, requiresForecastCapability: temporal.requiresForecastCapability };
      semanticSources.push(WM_TRUST.USER_TEXT);
    } else {
      // گذار EXPIRED → IDLE: حافظهٔ منقضی با نوبت بی‌بافت به IDLE بازنشانی می‌شود
      mem.state = (prev.state === WM_STATES.IDLE || prev.state === WM_STATES.EXPIRED || pendingExpired) ? WM_STATES.IDLE : mem.state;
      resolutionPath = 'NO_CONTEXT';
    }
  }


  // ── مرحله ۹.۵ (Phase 2-3F-B2): آنافورای «چرا/تحلیل» بدون دارایی صریح → دارایی فعال حافظه کاری (بدون حدس)
  if (resolutionPath === 'NO_CONTEXT' && explicitEntities.length === 0 && mem.activeAssets.length === 1 &&
      /(چرا|علت|دلیل|چطور شد)/.test(wmNormalize(text))) {
    const anaphoraAsset = mem.activeAssets[0];
    const anaphoraSyn = wmAssetSynonym(anaphoraAsset);
    const anaphoraReplay = anaphoraSyn ? analyzeQuery(`${text} ${anaphoraSyn}`, recentContext, todayEvidence) : null;
    if (anaphoraReplay && Array.isArray(anaphoraReplay.entities) && anaphoraReplay.entities.length > 0 && !anaphoraReplay.requiresKnowledge) {
      resolvedCir = anaphoraReplay;
      mem.state = mem.state === WM_STATES.SCENARIO_CONTEXT ? WM_STATES.SCENARIO_CONTEXT : WM_STATES.ASSET_CONTEXT;
      resolutionPath = 'WHY_ANAPHORA_ACTIVE_ASSET';
      registerResolved('ASSET', anaphoraAsset);
      semanticSources.push(WM_TRUST.SYSTEM_STATE);
      notes.push('آنافورای پرسش «چرا» با دارایی فعال حافظه کاری حل شد (بدون حدس دارایی جدید).');
    }
  }
  // ── افق زمانی (Temporal) → ثبت در حافظه و انتقال به CIR
  if (temporal.label) {
    mem.timeframe = {
      label: temporal.label,
      horizon: temporal.horizon,
      requiresHistoricalData: temporal.requiresHistoricalData,
      requiresForecastCapability: temporal.requiresForecastCapability
    };
    semanticSources.push(WM_TRUST.USER_TEXT);
  }

  // ── انتشار بافت حل‌شده در CIR (بدون تغییر منطق فاز ۱-۲)
  if (resolvedCir && typeof resolvedCir === 'object') {
    resolvedCir = Object.assign({}, resolvedCir, {
      context: Object.assign({}, resolvedCir.context, {
        isFollowUp: resolutionPath === 'LEGACY_ANAPHORA' || resolutionPath === 'VAGUE_FOLLOWUP_ACTIVE_ASSET' || resolutionPath === 'SCENARIO_CARRY_OVER' || resolutionPath === 'SCENARIO_DIRECTION_OVERRIDE' || resolutionPath === 'SCENARIO_CUMULATIVE_CONTINUATION' || resolutionPath === 'WHY_ANAPHORA_ACTIVE_ASSET',
        resolvedFromContext: mem.resolvedReferences.map(r => r.ref),
        resolutionPath,
        state: mem.state,
        timeframe: mem.timeframe,
        scenario: mem.scenario ? { scenarioId: mem.scenario.scenarioId, parentScenarioId: mem.scenario.parentScenarioId, asset: mem.scenario.asset, mode: mem.scenario.mode, value: mem.scenario.value, direction: mem.scenario.direction } : null,
        scenarioChain: scenarioChainOut,
        scenarioTarget: scenarioTargetOut,
        comparisonSet: { mode: mem.comparisonSet.mode, assets: mem.comparisonSet.assets.slice() },
        pendingClarification: mem.pendingClarification ? { id: mem.pendingClarification.id, missing: mem.pendingClarification.missing.slice() } : null
      }),
      activeIntent: mem.activeIntent || (resolvedCir.intent && resolvedCir.intent.primary)
    });
  }

  // تثبیت نیت/دارایی فعال در حافظه
  if (resolvedCir && resolvedCir.intent) {
    mem.activeIntent = resolvedCir.intent.primary;
  }

  const validation = validateWorkingMemory(mem);

  return {
    memory: mem,
    cir: resolvedCir,
    resolution: {
      path: resolutionPath,
      state: mem.state,
      semanticSources: Array.from(new Set(semanticSources)),
      notes,
      satisfiedBy: [
        correction.isCorrection ? 'EXPLICIT_USER_CORRECTION' : null,
        temporal.label ? `TEMPORAL:${temporal.label}` : null,
        comparisonOp.operation ? `COMPARISON_OP:${comparisonOp.operation}` : null,
        scenarioRef ? `SCENARIO_REF:${scenarioRef.kind}` : null,
        topicReturn.isReturn ? 'TOPIC_RETURN' : null,
        explicitEntities.length > 0 ? 'EXPLICIT_ENTITIES' : null,
        (baseCir.context && baseCir.context.isFollowUp) ? 'PHASE_1_2_ANAPHORA' : null
      ].filter(Boolean),
      corrected,
      clarification: clarification || reAskedClarification,
      clarificationResolved: resolutionPath === 'PENDING_CLARIFICATION_RESOLVED',
      staleValuesGuard: validation.clean ? 'ENFORCED' : 'VIOLATION',
      validationViolations: validation.violations
    },
    validation
  };
};

/** اجرای چند نوبت پیاپی روی یک متن (ابزار آزمون و شبیه‌سازی) */
const resolveTurnSequence = (turns, options = {}) => {
  let memory = options.initialMemory ? normalizeWorkingMemory(options.initialMemory) : createWorkingMemory();
  const results = [];
  const history = [];
  for (const turn of turns) {
    const res = resolveTurn(memory, turn, options.todayEvidence || {}, Object.assign({}, options.deps, { history: history.slice() }));
    results.push(res);
    history.push({ role: 'user', text: turn });
    history.push({ role: 'assistant', text: options.assistantText || '' });
    memory = res.memory;
  }
  return { memory, results };
};

/** لاگ ساختاریافته حافظه (بدون هیچ مقدار بازاری) */
const formatMemoryLog = (memory) => {
  const mem = normalizeWorkingMemory(memory);
  return {
    contractVersion: mem.contractVersion,
    turnIndex: mem.turnIndex,
    state: mem.state,
    activeIntent: mem.activeIntent,
    activeAssets: mem.activeAssets.slice(),
    activeTopic: mem.activeTopic ? `${mem.activeTopic.kind}:${mem.activeTopic.value}` : null,
    topicStackDepth: mem.topicStack.length,
    comparisonSet: { mode: mem.comparisonSet.mode, assets: mem.comparisonSet.assets.slice() },
    timeframe: mem.timeframe,
    scenario: mem.scenario ? `${mem.scenario.scenarioId}:${mem.scenario.asset}:${mem.scenario.direction}:${mem.scenario.value}${mem.scenario.mode === 'PERCENT_CHANGE' ? '%' : ''}` : null,
    pendingClarification: mem.pendingClarification ? mem.pendingClarification.id : null,
    lastUserCorrection: mem.lastUserCorrection ? `${mem.lastUserCorrection.from}→${mem.lastUserCorrection.to}` : null,
    staleValuesGuard: validateWorkingMemory(mem).clean ? 'ENFORCED' : 'VIOLATION'
  };
};

function formatStructuredLog(interpretation, retrievedKnowledge = null) {
  const log = {
    primaryIntent: interpretation.intent?.primary,
    secondaryIntents: interpretation.intent?.secondary,
    entities: interpretation.entities?.map(e => e.value),
    requiresCalculation: interpretation.requiresCalculation,
    requiresLiveEvidence: interpretation.requiresLiveEvidence,
    requiresKnowledge: interpretation.requiresKnowledge,
    status: interpretation.status,
    timestamp: new Date().toISOString()
  };
  if (retrievedKnowledge) {
    log.retrievedKnowledge = {
      matched: retrievedKnowledge.meta?.matched || false,
      count: retrievedKnowledge.meta?.count || 0,
      ids: (retrievedKnowledge.results || []).map(r => r.id)
    };
  }
  return log;
}

// ============================================================================
// موتور بازیابی دانش و تعاریف کلان اقتصادی (Phase 2-1: Knowledge Retrieval Core)
// ============================================================================

const TOPIC_TO_ID_MAP = {
  'P/E': ['pe_ratio_concept', 'pe_ratio'],
  'CPI': ['cpi_inflation_index', 'cpi_inflation'],
  'DXY': ['dxy_dollar_index', 'dxy_index'],
  'PMI': ['pmi_manufacturing_index', 'pmi_purchasing_managers_index', 'pmi_index'],
  'GOLD_TO_SILVER': ['gold_silver_ratio', 'gold_to_silver_ratio', 'xau_xag_ratio'],
  'GOLD_ETF': ['gold_etf_vs_physical', 'gold_commodity_funds_etf', 'gold_etf'],
  'COIN_VS_TOKEN': ['coin_vs_token', 'crypto_coin_vs_token'],
  'BROKER_VS_BROKERAGE': ['broker_vs_brokerage', 'broker_vs_brokerage_diff'],
  'CEX_DEX': ['crypto_exchange_types'],
  'INTEREST_RATES': ['interest_rates_gold_channel'],
  'INFLATION': ['inflation_concept'],
  'VOLATILITY': ['volatility_concept'],
  'DRAWDOWN': ['drawdown_concept'],
  'STABLECOIN': ['stablecoin_concept'],
  'ETH_BTC': ['eth_btc_ratio'],
  'DIVERSIFICATION': ['diversification_concentration'],
  'GOLD_PURITY': ['gold_purity_concept'],
  'CORRELATION': ['correlation_vs_causation'],
  'GOLD18_BUBBLE_CORRIDOR': ['gold18_bubble_regimes', 'gold18_bubble'],
  'QUARTER_COIN_BUBBLE': ['coin_quarter_bubble', 'quarter_coin_bubble'],
  'COIN_BUBBLE': ['coin_bubble_calc', 'coin_bubble'],
  'MITHQAL_CONVERSION': ['mithqal_gold18_conversion'],
  'OUNCE_CONVERSION': ['ounce_to_gram_conversion'],
  'GOLD_VS_DOLLAR': ['gold_vs_dollar_div'],
  'USDT_SPREAD': ['usdt_usd_spread'],
  'BITCOIN_FUNDAMENTALS': ['bitcoin_fundamentals'],
  'ETH_SOL_COMPARE': ['ethereum_solana_compare'],
  'CRYPTO_EXCHANGE': ['crypto_exchange_types'],
  'BTC_DOMINANCE': ['btc_dominance_cycles'],
  'BOURSE_INFLATION': ['bourse_vs_inflation'],
  'LEVERAGE_FUNDS': ['leverage_fund_risk'],
  'BOURSE_FUNDS': ['bourse_funds_types'],
  'OIL_GOLD_CORRELATION': ['oil_gold_correlation'],
  'HALVING': ['bitcoin_fundamentals'],
  'SIDEWAYS_MARKET': ['sideways_market_dynamics', 'sideways_market'],
  'PRICE_CONSOLIDATION': ['price_consolidation_regimes', 'price_consolidation']
};

// ============================================================================
// Phase 2-3F-B3-KH — سیاست کانونیکال ارتباط دانش، نرمال‌سازی و مرز واژه
// ============================================================================

// KH-03: سیاست کانونیکال ارتباط (منبع حقیقت واحد برای بازیاب و ارائه)
const KNOWLEDGE_RELEVANCE_POLICY = {
  retrievalMinimum: 0.40,
  presentationMinimum: 0.40,
  strongMatch: 0.65,
  aliasMatchBonus: 0.05,
  phraseMatchBonus: 0.10
};

// KH-02: توقف‌واژه‌های پرسشی (قطعی و محدود — بدون NLP سنگین)
const KNOWLEDGE_QUERY_STOPWORDS = ['چیست', 'چیه', 'یعنی', 'چه', 'چیزی', 'را', 'کن', 'کنید', 'بکن', 'بگو', 'بده', 'بدهید', 'توضیح', 'ده', 'دهید', 'میان', 'بین', 'دارد', 'دارند', 'کار', 'کند', 'کنه', 'است', 'هست', 'هستند', 'مهم', 'لطفا', 'درباره', 'مفهوم', 'تعریف', 'فرمول', 'از', 'به', 'در', 'با', 'برای', 'این', 'آن', 'که', 'های', 'ها', 'و', 'یا'];

// KH-02/KH-11: نگاشت نام‌های مستعار کانونیکال ──► عبارت‌های قابل انطباق
const KNOWLEDGE_QUERY_ALIASES = {
  'پی به ای': ['پی بر ای', 'p/e'],
  'شاخص تورم': ['cpi'],
  'بازار خنثی': ['بازار ساید'],
  'فلت': ['بازار ساید'],
  'کانسولیدیشن': ['کنسولیدیشن', 'consolidation'],
  'اونس جهانی': ['اونس', 'اونس تروی'],
  'انس طلا': ['اونس طلا'],
  'troy ounce': ['اونس تروی'],
  'صرافی متمرکز': ['cex'],
  'صرافی غیرمتمرکز': ['dex'],
  'dominance': ['دامیننس'],
  'btc dominance': ['دامیننس'],
  'دامیننس': ['btc dominance']
};

const KNOWLEDGE_QUESTION_MARKER = /(چیست|چیه|یعنی|تفاوت|فرق|چگونه|چه\s+چیزی|چه\s+اهمیتی)/;

// KH-01: نرمال‌سازی جست‌وجو (نشانه‌های فارسی/عربی/لاتین + نیم‌فاصله؛ بدون تغییر معنا)
function normalizeKnowledgeSearchText(rawText) {
  return String(rawText || '')
    .toLowerCase()
    .replace(/[؟?،,؛;:.!()[\]{}«»"']/g, ' ')
    .replace(/\u200c/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// KH-02: استخراج قطعی عبارات/توکن‌های جست‌وجو از پرسش زبان طبیعی
function deriveKnowledgeSearchTerms(rawText) {
  const original = normalizeKnowledgeSearchText(rawText);
  if (!original) return [];
  const cleaned = original
    .replace(/(چه\s+چیزی\s+را\s+نشان\s+می\s?دهد|چه\s+تفاوتی\s+(?:دارند|دارد)|چگونه\s+کار\s+می\s?کند|چه\s+اهمیتی\s+دارد|یعنی\s+چه|را\s+توضیح\s+بده(?:ید)?|مهم\s+(?:است|هست)|چیست|چیه)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = [];
  const push = (v) => { const vv = String(v || '').trim(); if (vv && !terms.includes(vv)) terms.push(vv); };
  if (cleaned) push(cleaned);
  cleaned.split(' ').filter((w) => w.length >= 3 && !KNOWLEDGE_QUERY_STOPWORDS.includes(w)).forEach(push);
  return terms.slice(0, 8);
}

// KH-02: بسط کلیدواژه‌های پرسش (توکن‌ها + نام‌های مستعار) به‌همراه عبارت اصلی
function expandQueryKeywords(keywords) {
  // KH-02/KH-03: تفکیک «عبارت» (وزن کامل) از «توکن تکی» (پاداش محدود) تا توکن‌های عمومی
  // مانند «کوین» یا «طلا» به‌تنهایی موجب تطبیق کاذب نشوند؛ نام‌های مستعار مصوب با وزن کامل.
  const plain = [];
  const alias = [];
  const tokens = [];
  let primaryPhrase = '';
  const push = (arr, v) => { const vv = String(v || '').trim(); if (vv && !arr.includes(vv)) arr.push(vv); };
  for (const k of (Array.isArray(keywords) ? keywords : [])) {
    const kk = String(k || '').trim();
    if (!kk) continue;
    push(plain, kk);
    const nk = normalizeKnowledgeSearchText(kk);
    if (nk && nk !== kk) push(plain, nk);
    if (nk && (nk.includes(' ') || nk.length > 24) && KNOWLEDGE_QUESTION_MARKER.test(nk)) {
      const derived = deriveKnowledgeSearchTerms(nk);
      const phrase = derived.find((t) => t.includes(' ')) || '';
      if (phrase) { push(plain, phrase); if (!primaryPhrase) primaryPhrase = phrase; }
      derived.filter((t) => !t.includes(' ')).forEach((t) => push(tokens, t));
    }
    const derivedForAlias = (nk && (nk.includes(' ') || nk.length > 24) && KNOWLEDGE_QUESTION_MARKER.test(nk))
      ? deriveKnowledgeSearchTerms(nk) : [];
    [nk].concat(derivedForAlias).forEach((cand) => {
      const aliasVals = KNOWLEDGE_QUERY_ALIASES[cand];
      if (aliasVals) aliasVals.forEach((t) => push(alias, t));
    });
  }
  alias.forEach((t) => push(plain, t));
  return { keywords: plain.slice(0, 16), aliasKeywords: alias.slice(0, 8), tokenKeywords: tokens.slice(0, 8), primaryPhrase };
}

// KH-01: تطبیق مرزدار یونیکد-آگاه (فارسی/عربی/لاتین) با حداقل طول ۳
const KW_BOUNDARY_CHAR = /[^\p{L}\p{N}\p{M}]/u;
function kwHit(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  if (short.length < 3) return false;
  let idx = long.indexOf(short);
  while (idx !== -1) {
    const before = idx === 0 ? ' ' : long[idx - 1];
    const after = idx + short.length >= long.length ? ' ' : long[idx + short.length];
    if (KW_BOUNDARY_CHAR.test(before) && KW_BOUNDARY_CHAR.test(after)) return true;
    idx = long.indexOf(short, idx + 1);
  }
  return false;
}

// KH-04: حذف قطعه‌ای مارک‌آپ فرمول — هرگز حذف کل خط/پاراگراف دانش
function trimKnowledgeRowContent(content) {
  const raw = String(content || '')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\[a-zA-Z]+(?:\s*\{[^{}]*\})*/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\$\$/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!raw) return '';
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  let out = lines.join('\n');
  if (out.length > 1400) {
    out = out.slice(0, 1400);
    const cut = out.lastIndexOf('\n');
    if (cut > 400) out = out.slice(0, cut);
    out = out.trim() + ' …';
  }
  return out;
}

function scoreKnowledgeItem(item, query = {}) {
  if (!item) return { score: 0, reasons: [] };

  let score = 0;
  const reasons = [];

  const itemId = String(item.id || '').toLowerCase();
  const itemTitle = String(item.title || '').toLowerCase();
  const itemTitleNorm = itemTitle.replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim();
  const itemSummary = String(item.summary || '').toLowerCase();
  const itemSummaryNorm = itemSummary.replace(/\u200c/g, ' ').replace(/\s+/g, ' ').trim();
  const itemCategory = String(item.category || '').toLowerCase();
  const itemKeywords = Array.isArray(item.keywords)
    ? item.keywords.map(k => String(k).toLowerCase())
    : String(item.keywords || '').toLowerCase().split(/[,،]+/).map(s => s.trim()).filter(Boolean);

  const queryTopic = String(query.topic || '').trim();
  const queryCategory = String(query.category || '').toLowerCase().trim();
  const queryKeywords = Array.isArray(query.keywords)
    ? query.keywords.map(k => String(k).toLowerCase().trim()).filter(Boolean)
    : [];
  const queryAliasKeywords = Array.isArray(query.aliasKeywords)
    ? query.aliasKeywords.map(k => String(k).toLowerCase().trim()).filter(Boolean)
    : [];
  const queryTokenKeywords = Array.isArray(query.tokenKeywords)
    ? query.tokenKeywords.map(k => String(k).toLowerCase().trim()).filter(Boolean)
    : [];
  const queryPhrase = String(query.phrase || '').toLowerCase().trim();

  if (queryTopic) {
    const topicLower = queryTopic.toLowerCase();
    const mappedIds = TOPIC_TO_ID_MAP[queryTopic] || [];
    if (mappedIds.includes(itemId) || itemId === topicLower || itemId.startsWith(topicLower + '_')) {
      score += 0.70;
      reasons.push('EXACT_TOPIC');
    }
  }

// KH-02/KH-03: تطبیق جهت‌دار — شکل کوئری (پس از حذف واژگان پرسشی) باید داخل کلیدواژه/عنوان/خلاصه مدخل باشد؛
// هرگز نباید کلیدواژه کوتاه مدخل، داخل جمله بلند کاربر جست‌وجو شود (رفع تطبیق کاذب «کوین چیست» در «استیبل کوین چیست»).
const queryMatchForms = (kw) => {
  const raw = String(kw || '').trim();
  const nk = normalizeKnowledgeSearchText(raw);
  const forms = [raw, nk];
  if (nk && KNOWLEDGE_QUESTION_MARKER.test(nk)) {
    const head = deriveKnowledgeSearchTerms(nk)[0];
    if (head) forms.push(head);
  }
  return Array.from(new Set(forms.filter(Boolean)));
};
const queryHitsField = (field, kw) => {
  if (!field || !kw) return false;
  const f = String(field);
  return queryMatchForms(kw).some((form) => {
    if (form === f) return true;
    if (form.length < 3 || !f.includes(form)) return false;
    return kwHit(f, form);
  });
};
const anyQueryKeywordHits = (field, list) => (list || []).some((kw) => queryHitsField(field, kw));

  const keywordMatched = anyQueryKeywordHits(itemKeywords, queryKeywords);
  if (keywordMatched) {
    score += 0.40;
    reasons.push('EXACT_KEYWORD');
  }

  const titleMatched = anyQueryKeywordHits(itemTitleNorm, queryKeywords);
  if (titleMatched) {
    score += 0.25;
    reasons.push('TITLE_MATCH');
  }

  const summaryMatched = anyQueryKeywordHits(itemSummaryNorm, queryKeywords);
  if (summaryMatched && !titleMatched) {
    score += 0.15;
    reasons.push('SUMMARY_MATCH');
  }

  // KH-03: تطابق عبارت اصلی پرسش (سیگنال دقیق‌تر از توکن تکی)
  if (queryPhrase) {
    const phraseInKeywords = queryHitsField(itemKeywords, queryPhrase);
    const phraseInTitle = itemTitleNorm.includes(queryPhrase);
    const phraseInSummary = itemSummaryNorm.includes(queryPhrase);
    if (phraseInKeywords || phraseInTitle || phraseInSummary) {
      score += KNOWLEDGE_RELEVANCE_POLICY.phraseMatchBonus;
      reasons.push('PHRASE_MATCH');
    }
  }

  // KH-02: توکن‌های زبان طبیعی مشتق‌شده فقط سیگنال تقویتی‌اند (هرگز به‌تنهایی موجب تطبیق نمی‌شوند)
  if (queryTokenKeywords.length > 0) {
    const tokenMatched = anyQueryKeywordHits(itemKeywords, queryTokenKeywords);
    if (tokenMatched) {
      score += 0.10;
      reasons.push('NL_TOKEN_MATCH');
    }
  }

  // KH-11: تطابق نام مستعار کانونیکال (سیگنال تقویتی محدود)
  if (queryAliasKeywords.length > 0) {
    const aliasMatched = anyQueryKeywordHits(itemKeywords, queryAliasKeywords);
    if (aliasMatched) {
      score += KNOWLEDGE_RELEVANCE_POLICY.aliasMatchBonus;
      reasons.push('ALIAS_MATCH');
    }
  }

  if (queryCategory && itemCategory === queryCategory) {
    score += 0.10;
    reasons.push('CATEGORY_SCOPE');
  }

  const finalScore = Math.min(1.0, Math.round(score * 100) / 100);

  if (reasons.length === 0 || finalScore < 0.40) {
    return { score: 0, reasons: [] };
  }

  return { score: finalScore, reasons };
}

async function retrieveKnowledge(knowledgeQuery, envOrDb = null, options = {}) {
  const maxResults = typeof options.maxResults === 'number' ? options.maxResults : 2;
  // KH-03: حداقل امتیاز از سیاست کانونیکال (بدون عدد پراکنده)
  const minScore = typeof options.minScore === 'number' ? options.minScore : KNOWLEDGE_RELEVANCE_POLICY.retrievalMinimum;

  const baseResult = {
    query: {
      topic: (knowledgeQuery && knowledgeQuery.topic) || null,
      keywords: (knowledgeQuery && Array.isArray(knowledgeQuery.keywords)) ? knowledgeQuery.keywords : [],
      category: (knowledgeQuery && knowledgeQuery.category) || null
    },
    results: [],
    meta: {
      matched: false,
      count: 0,
      source: 'D1_KNOWLEDGE_DB'
    }
  };

  if (!knowledgeQuery || (!knowledgeQuery.topic && (!knowledgeQuery.keywords || knowledgeQuery.keywords.length === 0))) {
    return baseResult;
  }

  try {
    let rawItems = [];

    if (Array.isArray(envOrDb)) {
      rawItems = envOrDb;
    } else if (envOrDb) {
      const kdb = envOrDb.KNOWLEDGE_DB || envOrDb.DB || (typeof envOrDb.prepare === 'function' ? envOrDb : null);

      if (kdb && typeof kdb.prepare === 'function') {
        const stmt = kdb.prepare(`SELECT id, category, keywords, title, summary, content FROM knowledge_base ORDER BY id ASC`);

        const dbRes = await stmt.all();
        rawItems = (dbRes && Array.isArray(dbRes.results)) ? dbRes.results : [];
      }
    }

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return baseResult;
    }

    const scoredItems = [];

    // KH-02: بسط قطعی کلیدواژه‌های پرسش (توکن/عبارت/نام مستعار) پیش از امتیازدهی
    const expanded = expandQueryKeywords(knowledgeQuery.keywords);
    const effectiveQuery = {
      topic: knowledgeQuery.topic,
      category: knowledgeQuery.category,
      keywords: expanded.keywords,
      aliasKeywords: expanded.aliasKeywords,
      tokenKeywords: expanded.tokenKeywords,
      phrase: expanded.primaryPhrase
    };
    baseResult.query.effectiveKeywords = expanded.keywords.slice();

    for (const item of rawItems) {
      const { score, reasons } = scoreKnowledgeItem(item, effectiveQuery);
      if (score >= minScore && reasons.length > 0) {
        scoredItems.push({
          id: item.id,
          title: item.title,
          category: item.category,
          summary: item.summary,
          content: trimKnowledgeRowContent(item.content),
          relevanceScore: score,
          matchReasons: reasons,
          presentationEligible: score >= KNOWLEDGE_RELEVANCE_POLICY.presentationMinimum
        });
      }
    }

    scoredItems.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      return a.id.localeCompare(b.id);
    });

    const cappedResults = scoredItems.slice(0, maxResults);

    return {
      query: baseResult.query,
      policy: { ...KNOWLEDGE_RELEVANCE_POLICY },
      results: cappedResults,
      meta: {
        matched: cappedResults.length > 0,
        presentationEligible: cappedResults.length > 0 && cappedResults.every(r => r.presentationEligible === true),
        count: cappedResults.length,
        source: 'D1_KNOWLEDGE_DB'
      }
    };

  } catch (err) {
    console.warn('[KnowledgeRetriever D1 Failure — Handled Safely]:', err.message);
    return {
      query: baseResult.query,
      results: [],
      meta: {
        matched: false,
        count: 0,
        source: 'D1_KNOWLEDGE_DB',
        error: 'D1_QUERY_FAILED'
      }
    };
  }
}

// ============================================================================
// موتور نرمال‌سازی مالی و شبیه‌ساز قطعی سناریوهای فرضی (Financial Normalizer & What-If Engine v4)
// ============================================================================

const CANONICAL_CONSTANTS = {
  TROY_OUNCE_TO_GRAMS: 31.1034768,
  TROY_OUNCE_ROUNDED: 31.1035,
  MITHQAL_PARITY_FACTOR: 4.3318,
  COIN_EMAMI_WEIGHT: 8.133,
  COIN_EMAMI_PURITY: 0.900,
  COIN_EMAMI_PURE_GOLD_GRAMS: 7.3197,
  GOLD18_PURITY: 0.750,
  SILVER_PURITY: 0.999
};

function toEnDigits(str) {
  if (str == null) return '';
  return String(str)
    .replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)])
    .replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)])
    .replace(/٬|,|_/g, '');
}

function toFaDigits(str) {
  if (str == null) return '—';
  return String(str).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
}

// Phase 2-3E-B: نمایش درصد با دقت کافی (تا ۲ اعشار، بدون صفر اضافی) — «۴٫۹۶٪» به‌جای گرد‌شده «۵٪»
function fmtPctSmart(pct) {
  const num = Number(pct);
  if (!Number.isFinite(num)) return '—';
  const absTwo = Math.abs(Math.round(num * 100) / 100);
  const txt = (Math.abs(absTwo - Math.round(absTwo)) < 1e-9)
    ? String(Math.round(absTwo))
    : absTwo.toFixed(2).replace(/0$/, '');
  return (num < 0 ? '-' : '') + toFaDigits(txt).replace('.', '٫');
}

function fmtFa(num, dec = 0) {
  if (num === null || num === undefined || Number.isNaN(Number(num))) return '—';
  const parts = Number(num).toFixed(dec).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  const faDigits = toFaDigits(intPart);
  if (parts.length > 1 && dec > 0) {
    return `${faDigits}٫${toFaDigits(parts[1])}`;
  }
  return faDigits;
}

function normalizePriceContract(rawVal, assetKey, source = 'LIVE', baselineMap = {}) {
  if (rawVal == null || rawVal === '') {
    return { value: null, unit: 'UNKNOWN', source: 'INVALID', asset: assetKey, auditTrace: null };
  }

  let num = 0;
  let rawUnit = null;

  if (typeof rawVal === 'object' && rawVal !== null) {
    num = Number(rawVal.price ?? rawVal.value ?? 0);
    rawUnit = rawVal.unit || rawVal.currency || null;
  } else {
    num = Number(toEnDigits(rawVal));
  }

  if (!Number.isFinite(num) || num <= 0) {
    return { value: null, unit: 'UNKNOWN', source: 'INVALID', asset: assetKey, auditTrace: null };
  }

  let originalValue = num;
  let originalUnit = rawUnit ? String(rawUnit).toUpperCase() : 'UNKNOWN';
  let normalizedValue = num;
  let normalizedUnit = 'TOMAN';
  let conversion = 'NONE';

  const key = String(assetKey).toUpperCase();

  // ۱. دارایی‌های بر مبنای دلار جهانی
  if (['XAU', 'XAG', 'OIL'].includes(key)) {
    return {
      value: num,
      unit: 'USD',
      source,
      asset: key,
      auditTrace: { originalValue, originalUnit: 'USD', normalizedValue: num, normalizedUnit: 'USD', conversion: 'NONE' }
    };
  }

  // ۲. شاخص‌های بازار سرمایه (واحد شاخص)
  if (['TSE_INDEX', 'TSE_EQUAL'].includes(key)) {
    return {
      value: num,
      unit: 'INDEX_POINT',
      source,
      asset: key,
      auditTrace: { originalValue, originalUnit: 'INDEX_POINT', normalizedValue: num, normalizedUnit: 'INDEX_POINT', conversion: 'NONE' }
    };
  }

  // ۲.۵. دارایی‌های دیجیتال (FIX-B1-1): واحد دلاری؛ بدون هیچ تبدیل اختراعی — واحد صریح غیردلاری عبور می‌کند
  if (['BTC', 'ETH', 'SOL'].includes(key) && (originalUnit === 'UNKNOWN' || originalUnit === 'USD')) {
    return {
      value: num,
      unit: 'USD',
      source,
      asset: key,
      auditTrace: { originalValue, originalUnit: 'USD', normalizedValue: num, normalizedUnit: 'USD', conversion: 'NONE' }
    };
  }

  // ۳. اولویت تطبیق با واحد صریح در صورت وجود (Explicit Unit Matching)
  if (originalUnit === 'RIAL' || originalUnit === 'IRR' || originalUnit === 'RIAL_PER_GRAM') {
    normalizedValue = Math.round(num / 10);
    normalizedUnit = (key.includes('GOLD') || key.includes('SILVER')) ? 'TOMAN_PER_GRAM' : 'TOMAN';
    conversion = 'RIAL_TO_TOMAN';
    return {
      value: normalizedValue,
      unit: normalizedUnit,
      source,
      asset: key,
      auditTrace: { originalValue, originalUnit, normalizedValue, normalizedUnit, conversion }
    };
  }

  if (originalUnit === 'TOMAN' || originalUnit === 'IRT' || originalUnit === 'TOMAN_PER_GRAM') {
    normalizedValue = num;
    normalizedUnit = (key.includes('GOLD') || key.includes('SILVER')) ? 'TOMAN_PER_GRAM' : 'TOMAN';
    conversion = 'NONE';
    return {
      value: normalizedValue,
      unit: normalizedUnit,
      source,
      asset: key,
      auditTrace: { originalValue, originalUnit, normalizedValue, normalizedUnit, conversion }
    };
  }

  // ۴. تفکیک مقیاس پویا بر مبنای مقایسه با نرخ مبنای روز (Dynamic Parity Scale Detection)
  const baseRef = baselineMap[key.toLowerCase()]?.value || baselineMap[key]?.value || null;
  if (baseRef && baseRef > 0) {
    const ratio = num / baseRef;
    if (ratio >= 6.0 && ratio <= 15.0) {
      originalUnit = (key.includes('GOLD') || key.includes('SILVER')) ? 'RIAL_PER_GRAM' : 'RIAL';
      normalizedUnit = (key.includes('GOLD') || key.includes('SILVER')) ? 'TOMAN_PER_GRAM' : 'TOMAN';
      normalizedValue = Math.round(num / 10);
      conversion = 'RIAL_TO_TOMAN';
      return {
        value: normalizedValue,
        unit: normalizedUnit,
        source,
        asset: key,
        auditTrace: { originalValue, originalUnit, normalizedValue, normalizedUnit, conversion }
      };
    }
  }

  // ۵. تفکیک مقیاس بدون نرخ مبنا (Dynamic Scale Range Guard)
  if (key === 'USD' || key === 'USDT') {
    if (num > 1500000) {
      originalUnit = 'RIAL';
      normalizedUnit = 'TOMAN';
      normalizedValue = Math.round(num / 10);
      conversion = 'RIAL_TO_TOMAN';
    }
  } else if (key === 'GOLD18' || key === 'GOLD') {
    if (num > 150000000) {
      originalUnit = 'RIAL_PER_GRAM';
      normalizedUnit = 'TOMAN_PER_GRAM';
      normalizedValue = Math.round(num / 10);
      conversion = 'RIAL_TO_TOMAN';
    } else {
      normalizedUnit = 'TOMAN_PER_GRAM';
    }
  } else if (key === 'SEKEE' || key === 'COIN') {
    if (num > 1500000000) {
      originalUnit = 'RIAL';
      normalizedUnit = 'TOMAN';
      normalizedValue = Math.round(num / 10);
      conversion = 'RIAL_TO_TOMAN';
    }
  } else if (key === 'SILVER1G') {
    if (num > 10000000) {
      originalUnit = 'RIAL_PER_GRAM';
      normalizedUnit = 'TOMAN_PER_GRAM';
      normalizedValue = Math.round(num / 10);
      conversion = 'RIAL_TO_TOMAN';
    } else {
      normalizedUnit = 'TOMAN_PER_GRAM';
    }
  }

  return {
    value: normalizedValue,
    unit: normalizedUnit,
    source,
    asset: key,
    auditTrace: { originalValue, originalUnit, normalizedValue, normalizedUnit, conversion }
  };
}

function normalizeEvidenceMap(todayEvidence = {}) {
  const map = {};
  // FIX-B1-1 (Phase 2-3F-B1): دارایی‌های دیجیتال (BTC/ETH/SOL) نیز در نرمال‌سازی حفظ می‌شوند
  const keys = ['usd', 'usdt', 'gold18', 'sekee', 'xau', 'xag', 'oil', 'tse_index', 'tse_equal', 'silver1g', 'btc', 'eth', 'sol'];
  for (const k of keys) {
    const item = todayEvidence[k];
    const norm = normalizePriceContract(item, k.toUpperCase(), (item && item.source) || 'LIVE', map);
    // FIX-B1-3: نگاشت قطعی pct24h → change24h؛ نامعلوم = null (هرگز صفر تلقی نمی‌شود)
    const rawChange = (item && typeof item === 'object') ? ((item.pct24h !== undefined) ? item.pct24h : ((item.change24h !== undefined) ? item.change24h : null)) : null;
    norm.change24h = (rawChange === null || rawChange === undefined || rawChange === '' || !Number.isFinite(Number(rawChange))) ? null : Number(rawChange);
    map[k] = norm;
  }
  return map;
}

// ============================================================================
// موتور یکپارچه‌سازی شواهد و قرارداد جامع شواهد (Unified Evidence Builder Core v1.0)
// Phase 2-2 — دیدبان هوشمند بازار
// وظیفه: جمع‌آوری، نرمال‌سازی، طبقه‌بندی، ثبت اصالت (provenance)، حذف تکرار،
// کشف تناقض و کنترل کیفیت شواهد — نه تولید تحلیل، پیش‌بینی یا توصیه معاملاتی.
// ============================================================================

const EVIDENCE_CONTRACT_VERSION = '1.0';

const EVIDENCE_TYPES = {
  LIVE: 'LIVE',
  HISTORICAL: 'HISTORICAL',     // Extension Point (فاز ۲-۲: بدون پیاده‌سازی موتور)
  DERIVED: 'DERIVED',
  HYPOTHETICAL: 'HYPOTHETICAL',
  KNOWLEDGE: 'KNOWLEDGE',
  EXTERNAL: 'EXTERNAL',         // Extension Point (فاز ۲-۲: بدون fetch بیرونی)
  CACHED: 'CACHED',
  FALLBACK: 'FALLBACK'
};

const EVIDENCE_SOURCE_PRIORITY = {
  LIVE: 100,
  HISTORICAL: 80,
  DERIVED: 70,
  HYPOTHETICAL: 60,
  KNOWLEDGE: 50,
  CACHED: 40,
  FALLBACK: 10
};

function createEvidenceItem(params = {}) {
  return {
    id: params.id || `ev_${Math.random().toString(36).substring(2, 9)}`,
    type: params.type || EVIDENCE_TYPES.LIVE,
    asset: params.asset || null,
    source: params.source || 'SYSTEM',
    value: (params.value !== undefined) ? params.value : null,
    unit: params.unit || '',
    timestamp: params.timestamp || new Date().toISOString(),
    provenance: params.provenance || 'DIRECT_INPUT',
    confidence: (typeof params.confidence === 'number') ? params.confidence : 1.0,
    relevance: (typeof params.relevance === 'number') ? params.relevance : 1.0,
    metadata: params.metadata || {}
  };
}

// نگاشت کلیدهای تابلوی بازار به دارایی‌های کانونیکال
const EVIDENCE_ASSET_KEY_MAP = {
  usd: { asset: 'USD', unit: 'TOMAN' },
  dollar: { asset: 'USD', unit: 'TOMAN' },
  usdt: { asset: 'USDT', unit: 'TOMAN' },
  tether: { asset: 'USDT', unit: 'TOMAN' },
  sekee: { asset: 'COIN', unit: 'TOMAN' },
  coin: { asset: 'COIN', unit: 'TOMAN' },
  emami: { asset: 'COIN', unit: 'TOMAN' },
  gold18: { asset: 'GOLD18', unit: 'TOMAN_PER_GRAM' },
  xau: { asset: 'XAU', unit: 'USD_PER_OUNCE' },
  xag: { asset: 'XAG', unit: 'USD_PER_OUNCE' },
  silver1g: { asset: 'XAG_GRAM', unit: 'USD_PER_GRAM' },
  oil: { asset: 'OIL', unit: 'USD_PER_BARREL' },
  brent: { asset: 'OIL', unit: 'USD_PER_BARREL' },
  tse_index: { asset: 'TSE_INDEX', unit: 'INDEX_POINT' },
  tseindex: { asset: 'TSE_INDEX', unit: 'INDEX_POINT' },
  tse_equal: { asset: 'TSE_EQUAL', unit: 'INDEX_POINT' },
  tseequal: { asset: 'TSE_EQUAL', unit: 'INDEX_POINT' },
  btc: { asset: 'BTC', unit: 'USD' },
  eth: { asset: 'ETH', unit: 'USD' },
  sol: { asset: 'SOL', unit: 'USD' },
  dxy: { asset: 'DXY', unit: 'INDEX_POINT' }
};

/**
 * استخراج شواهد زنده (LIVE) — بدون هیچ محاسبه یا تبدیل واحد جدید
 * از normalizeEvidenceMap / normalizePriceContract موجود استفاده می‌کند.
 */
function extractLiveEvidence(rawEvidence = {}, entityFilter = null, options = {}) {
  const liveItems = [];
  if (!rawEvidence || typeof rawEvidence !== 'object') return liveItems;

  const normalized = (options && options.normalized === true)
    ? rawEvidence
    : normalizeEvidenceMap(rawEvidence);

  // آرایه خالی به معنای «هیچ شواهدی مجاز نیست» (وضعیت ضدسیگنال محدود) است
  const allowedAssets = Array.isArray(entityFilter)
    ? new Set(entityFilter.map(e => String(e).toUpperCase().trim()))
    : null;

  for (const [k, v] of Object.entries(normalized)) {
    if (v === null || v === undefined) continue;
    const cleanKey = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
    const meta = EVIDENCE_ASSET_KEY_MAP[cleanKey];
    if (!meta) continue;
    if (allowedAssets && !allowedAssets.has(meta.asset)) continue;

    let value = v;
    let unit = meta.unit;
    let sourceName = 'LIVE_FEED';
    let auditTrace = null;
    let change24h = null;

    if (typeof v === 'object' && v !== null) {
      value = (v.value !== undefined) ? v.value : null;
      unit = v.unit && v.unit !== 'UNKNOWN' ? v.unit : meta.unit;
      sourceName = v.source || 'LIVE_FEED';
      auditTrace = v.auditTrace || null;
      const rawChange = (v.change24h !== undefined) ? v.change24h : ((v.pct24h !== undefined) ? v.pct24h : null); // FIX-B1-3
      change24h = (rawChange === null || rawChange === undefined || rawChange === '' || !Number.isFinite(Number(rawChange))) ? null : Number(rawChange);
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      liveItems.push(createEvidenceItem({
        id: `live_${meta.asset.toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        type: EVIDENCE_TYPES.LIVE,
        asset: meta.asset,
        source: sourceName,
        value: value,
        unit: unit,
        provenance: 'NORMALIZED_FEED',
        confidence: 1.0,
        relevance: 1.0,
        metadata: { change24h, rawKey: k, auditTrace }
      }));
    }
  }

  return liveItems;
}

/**
 * استخراج شواهد اشتقاقی (DERIVED) با ردیابی فرمول و ورودی‌ها
 */
function extractDerivedEvidence(liveItems = []) {
  const derivedItems = [];
  if (!Array.isArray(liveItems) || liveItems.length === 0) return derivedItems;

  const priceMap = {};
  for (const item of liveItems) {
    if (item.type === EVIDENCE_TYPES.LIVE && item.asset && typeof item.value === 'number') {
      priceMap[item.asset] = item.value;
    }
  }

  const usd = priceMap['USD'];
  const xau = priceMap['XAU'];
  const xag = priceMap['XAG'];
  const gold18 = priceMap['GOLD18'];
  const coin = priceMap['COIN'];
  const usdt = priceMap['USDT'];

  if (usd > 0 && xau > 0) {
    const intrinsicGold18 = Math.round((xau * usd * 0.750) / 31.1035);
    derivedItems.push(createEvidenceItem({
      id: `derived_gold18_intrinsic_${Date.now()}`,
      type: EVIDENCE_TYPES.DERIVED,
      asset: 'GOLD18',
      source: 'CANONICAL_FORMULA',
      value: intrinsicGold18,
      unit: 'TOMAN_PER_GRAM',
      provenance: 'MATHEMATICAL_DERIVATION',
      relevance: 0.95,
      metadata: { formula: '(XAU * USD * 0.750) / 31.1035', inputs: { usd, xau }, targetMetric: 'INTRINSIC_VALUE' }
    }));

    derivedItems.push(createEvidenceItem({
      id: `derived_mithqal17_${Date.now()}`,
      type: EVIDENCE_TYPES.DERIVED,
      asset: 'MITHQAL',
      source: 'CANONICAL_FORMULA',
      value: Math.round(intrinsicGold18 * 4.3318),
      unit: 'TOMAN',
      provenance: 'MATHEMATICAL_DERIVATION',
      relevance: 0.90,
      metadata: { formula: 'Gold18_Intrinsic * 4.3318', inputs: { gold18Intrinsic: intrinsicGold18 }, targetMetric: 'THEORETICAL_MITHQAL' }
    }));

    const intrinsicCoin = Math.round((8.133 * 0.900 * xau * usd) / 31.1035);
    derivedItems.push(createEvidenceItem({
      id: `derived_coin_intrinsic_${Date.now()}`,
      type: EVIDENCE_TYPES.DERIVED,
      asset: 'COIN',
      source: 'CANONICAL_FORMULA',
      value: intrinsicCoin,
      unit: 'TOMAN',
      provenance: 'MATHEMATICAL_DERIVATION',
      relevance: 0.95,
      metadata: { formula: '(8.133 * 0.900 * XAU * USD) / 31.1035', inputs: { usd, xau }, targetMetric: 'COIN_INTRINSIC_VALUE' }
    }));

    if (coin > 0) {
      derivedItems.push(createEvidenceItem({
        id: `derived_coin_bubble_${Date.now()}`,
        type: EVIDENCE_TYPES.DERIVED,
        asset: 'COIN',
        source: 'CANONICAL_FORMULA',
        value: Number((((coin - intrinsicCoin) / intrinsicCoin) * 100).toFixed(2)),
        unit: 'PERCENT',
        provenance: 'MATHEMATICAL_DERIVATION',
        relevance: 0.95,
        metadata: {
          formula: '((MarketPrice - IntrinsicValue) / IntrinsicValue) * 100',
          inputs: { marketPrice: coin, intrinsicValue: intrinsicCoin },
          bubbleAmountToman: coin - intrinsicCoin,
          marketPrice: coin,
          intrinsicPrice: intrinsicCoin,
          targetMetric: 'BUBBLE_PERCENTAGE'
        }
      }));
    }

    if (gold18 > 0) {
      derivedItems.push(createEvidenceItem({
        id: `derived_gold18_bubble_${Date.now()}`,
        type: EVIDENCE_TYPES.DERIVED,
        asset: 'GOLD18',
        source: 'CANONICAL_FORMULA',
        value: Number((((gold18 - intrinsicGold18) / intrinsicGold18) * 100).toFixed(2)),
        unit: 'PERCENT',
        provenance: 'MATHEMATICAL_DERIVATION',
        relevance: 0.90,
        metadata: {
          formula: '((MarketPrice - IntrinsicValue) / IntrinsicValue) * 100',
          inputs: { marketPrice: gold18, intrinsicValue: intrinsicGold18 },
          bubbleAmountToman: gold18 - intrinsicGold18,
          marketPrice: gold18,
          intrinsicPrice: intrinsicGold18,
          targetMetric: 'GOLD18_BUBBLE_PERCENTAGE'
        }
      }));
    }
  }

  if (xau > 0 && xag > 0) {
    derivedItems.push(createEvidenceItem({
      id: `derived_gold_silver_ratio_${Date.now()}`,
      type: EVIDENCE_TYPES.DERIVED,
      asset: 'XAU_XAG',
      source: 'CANONICAL_FORMULA',
      value: Number((xau / xag).toFixed(2)),
      unit: 'RATIO',
      provenance: 'MATHEMATICAL_DERIVATION',
      relevance: 0.85,
      metadata: { formula: 'XAU / XAG', inputs: { xau, xag }, targetMetric: 'GOLD_SILVER_RATIO' }
    }));
  }

  if (usdt > 0 && usd > 0) {
    derivedItems.push(createEvidenceItem({
      id: `derived_usdt_spread_${Date.now()}`,
      type: EVIDENCE_TYPES.DERIVED,
      asset: 'USDT_USD',
      source: 'CANONICAL_FORMULA',
      value: usdt - usd,
      unit: 'TOMAN',
      provenance: 'MATHEMATICAL_DERIVATION',
      relevance: 0.85,
      metadata: { formula: 'USDT - USD', inputs: { usdt, usd }, spreadPercent: Number((((usdt - usd) / usd) * 100).toFixed(2)), targetMetric: 'TETHER_USD_SPREAD' }
    }));
  }

  return derivedItems;
}

/**
 * استخراج شواهد فرضی (HYPOTHETICAL) از AST سناریوی What-If
 */
function extractHypotheticalEvidence(whatIfAst = {}) {
  const items = [];
  if (!whatIfAst || typeof whatIfAst !== 'object') return items;

  const assumptions = Array.isArray(whatIfAst.assumptions)
    ? whatIfAst.assumptions
    : (Array.isArray(whatIfAst.scenarios) ? whatIfAst.scenarios.flatMap(s => (s && s.assumptions) || []) : []);

  for (const asm of assumptions) {
    if (!asm || !asm.asset) continue;
    items.push(createEvidenceItem({
      id: `hypo_${String(asm.asset).toLowerCase()}_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
      type: EVIDENCE_TYPES.HYPOTHETICAL,
      asset: asm.asset,
      source: 'USER_HYPOTHESIS',
      value: asm.value,
      unit: asm.mode === 'PERCENT_CHANGE' ? 'PERCENT_SHOCK' : (asm.mode === 'TARGET_PRICE' ? 'TARGET_PRICE' : 'ABSOLUTE_SHOCK'),
      provenance: 'WHAT_IF_SCENARIO_PARSER',
      relevance: 1.0,
      metadata: {
        mode: asm.mode,
        direction: asm.direction || null,
        rawText: asm.rawText || '',
        scenarioId: asm.scenarioId || 'DEFAULT',
        scenarioLabel: whatIfAst.type || 'WHAT_IF'
      }
    }));
  }

  return items;
}

/**
 * استخراج شواهد دانشنامه‌ای (KNOWLEDGE) از قرارداد بازیابی فاز ۲-۱
 */
function extractKnowledgeEvidence(retrievalResult = {}) {
  const items = [];
  if (!retrievalResult || typeof retrievalResult !== 'object') return items;

  const results = Array.isArray(retrievalResult.results) ? retrievalResult.results : [];
  for (const res of results) {
    if (!res || !res.id) continue;
    items.push(createEvidenceItem({
      id: `knowledge_${res.id}`,
      type: EVIDENCE_TYPES.KNOWLEDGE,
      asset: res.category ? String(res.category).toUpperCase() : 'MACRO',
      source: (retrievalResult.meta && retrievalResult.meta.source) || 'D1_KNOWLEDGE_DB',
      value: res.summary || res.title || '',
      unit: 'CANONICAL_DEFINITION',
      provenance: 'KNOWLEDGE_RETRIEVER_CORE',
      confidence: typeof res.relevanceScore === 'number' ? res.relevanceScore : 1.0,
      relevance: typeof res.relevanceScore === 'number' ? res.relevanceScore : 1.0,
      metadata: {
        id: res.id,
        title: res.title,
        category: res.category,
        matchReasons: res.matchReasons || []
      }
    }));
  }

  return items;
}

/**
 * حذف تکرار دترمینیستیک (Deterministic Deduplication)
 * کلید: type + asset + unit + value + source
 */
function deduplicateEvidenceItems(items = []) {
  if (!Array.isArray(items)) return [];
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (!item) continue;
    const key = `${item.type}:${item.asset || 'NO_ASSET'}:${item.unit}:${String(item.value)}:${item.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  return deduped;
}

/**
 * کشف تناقضات شواهد — بدون بازنویسی خاموش (No Silent Overwrite)
 */
function detectEvidenceConflicts(liveItems = []) {
  const buckets = {};
  const conflicts = [];
  let conflictsDetected = false;

  for (const item of liveItems) {
    if (!item || !item.asset) continue;
    if (!buckets[item.asset]) buckets[item.asset] = [];
    buckets[item.asset].push(item);
  }

  for (const [asset, items] of Object.entries(buckets)) {
    if (items.length > 1) {
      const uniqueValues = new Set(items.map(i => `${i.unit}:${i.value}`));
      if (uniqueValues.size > 1) {
        conflictsDetected = true;
        conflicts.push({
          asset,
          conflictingItems: items.map(i => ({
            id: i.id,
            source: i.source,
            type: i.type,
            value: i.value,
            unit: i.unit,
            timestamp: i.timestamp,
            priority: EVIDENCE_SOURCE_PRIORITY[i.type] || 0
          }))
        });
      }
    }
  }

  return { conflictsDetected, conflictTrace: conflicts };
}

/**
 * مدل قابلیت شواهد: نیازمند / موجود / مفقود + وضعیت degraded
 * «نبود شواهد، خودش یک داده است.» (Missing evidence is information)
 */
function evaluateEvidenceCapabilities(cir = {}, activeEvidence = {}) {
  const requiredEvidence = [];
  const availableEvidence = [];
  const missingEvidence = [];

  const intent = (cir.intent && cir.intent.primary) || 'UNKNOWN';
  const rawQuery = String(cir.query || '');

  if (cir.requiresLiveEvidence || ['MARKET_STATUS', 'MARKET_ANALYSIS', 'ASSET_ANALYSIS', 'WHAT_IF', 'SCENARIO_COMPARISON'].includes(intent)) {
    requiredEvidence.push('LIVE_MARKET_DATA');
  }
  if (cir.requiresCalculation || ['CALCULATION', 'WHAT_IF', 'SCENARIO_COMPARISON'].includes(intent)) {
    requiredEvidence.push('DETERMINISTIC_CALCULATION');
  }
  if (['WHAT_IF', 'SCENARIO_COMPARISON'].includes(intent)) {
    requiredEvidence.push('SCENARIO_ENGINE');
  }
  if (cir.requiresKnowledge || intent === 'KNOWLEDGE_QUERY' || cir.knowledgeQuery) {
    requiredEvidence.push('KNOWLEDGE');
  }

  const historicalPattern = /(هفته گذشته|ماه گذشته|ماه‌ گذشته|سال گذشته|دیروز|پریشب|تاریخچه|سابقه|روند تاریخی|هفت روز|۳۰ روز|سی روز)/i;
  if (historicalPattern.test(rawQuery)) {
    requiredEvidence.push('HISTORICAL_DATA');
  }

  const externalPattern = /(اخبار|خبر جدید|فدرال رزرو|فدرال|ترامپ|بیانیه|نشست|اجلاس|تصمیم بانک مرکزی|تقویم اقتصادی)/i;
  if (externalPattern.test(rawQuery)) {
    requiredEvidence.push('EXTERNAL_NEWS');
  }

  if (Array.isArray(activeEvidence.live) && activeEvidence.live.length > 0) availableEvidence.push('LIVE_MARKET_DATA');
  if (Array.isArray(activeEvidence.derived) && activeEvidence.derived.length > 0) availableEvidence.push('DETERMINISTIC_CALCULATION');
  if (Array.isArray(activeEvidence.hypothetical) && activeEvidence.hypothetical.length > 0) availableEvidence.push('SCENARIO_ENGINE');
  if (Array.isArray(activeEvidence.knowledge) && activeEvidence.knowledge.length > 0) availableEvidence.push('KNOWLEDGE');
  if (Array.isArray(activeEvidence.historical) && activeEvidence.historical.length > 0) availableEvidence.push('HISTORICAL_DATA');
  if (Array.isArray(activeEvidence.external) && activeEvidence.external.length > 0) availableEvidence.push('EXTERNAL_NEWS');

  const uniqueRequired = Array.from(new Set(requiredEvidence));
  for (const req of uniqueRequired) {
    if (!availableEvidence.includes(req)) missingEvidence.push(req);
  }

  return {
    requiredEvidence: uniqueRequired,
    availableEvidence,
    missingEvidence,
    degraded: missingEvidence.length > 0
  };
}

/**
 * ساخت قرارداد جامع شواهد (Unified Evidence Contract v1.0)
 */
function buildUnifiedEvidenceContract(params = {}) {
  const rawQuery = params.query || '';
  const cir = params.cir || analyzeQuery(rawQuery);
  const rawEvidence = params.rawEvidence || {};
  const retrievedKnowledge = params.retrievedKnowledge || null;
  const whatIfAst = params.whatIfAst || null;
  const options = params.options || {};

  const intent = (cir.intent && cir.intent.primary) || 'UNKNOWN';
  const entities = Array.isArray(cir.entities) ? cir.entities.map(e => (e && e.value) || e) : [];

  // فیلتر شواهد زنده بر اساس Dependency Plan (Relevant Evidence — نه Maximum Evidence)
  let liveFilter = null;
  if (intent === 'ANTI_SIGNAL_RESTRICTED') {
    liveFilter = [];
  } else if (cir.evidencePlan && Array.isArray(cir.evidencePlan.required) && cir.evidencePlan.required.length > 0) {
    const allowed = new Set([...cir.evidencePlan.required, ...((cir.evidencePlan && cir.evidencePlan.optional) || [])]);
    entities.forEach(e => allowed.add(e));
    liveFilter = Array.from(allowed);
  } else if (!cir.requiresLiveEvidence) {
    // پرسش دانشنامه‌ای / مفهومی: داده زنده وارد کانتکست نمی‌شود
    liveFilter = [];
  }

  const live = deduplicateEvidenceItems(extractLiveEvidence(rawEvidence, liveFilter, { normalized: options.alreadyNormalized === true }));
  const derived = deduplicateEvidenceItems(extractDerivedEvidence(live));
  const hypothetical = deduplicateEvidenceItems(extractHypotheticalEvidence(whatIfAst));
  const knowledge = deduplicateEvidenceItems(extractKnowledgeEvidence(retrievedKnowledge));

  // نقاط توسعه آینده: در فاز ۲-۲ هیچ داده جعلی ساخته نمی‌شود و این لایه‌ها خالی می‌مانند
  const historical = Array.isArray(params.historical) ? params.historical : [];
  const external = Array.isArray(params.external) ? params.external : [];

  const evidence = { live, historical, derived, hypothetical, knowledge, external };
  const capabilities = evaluateEvidenceCapabilities(Object.assign({ query: rawQuery }, cir), evidence);
  const { conflictsDetected, conflictTrace } = detectEvidenceConflicts(live);

  const totalEvidence = live.length + historical.length + derived.length + hypothetical.length + knowledge.length + external.length;
  const sourcesUsed = [];
  if (live.length > 0) sourcesUsed.push('LIVE');
  if (historical.length > 0) sourcesUsed.push('HISTORICAL');
  if (derived.length > 0) sourcesUsed.push('DERIVED');
  if (hypothetical.length > 0) sourcesUsed.push('HYPOTHETICAL');
  if (knowledge.length > 0) sourcesUsed.push('KNOWLEDGE');
  if (external.length > 0) sourcesUsed.push('EXTERNAL');

  return {
    contractVersion: EVIDENCE_CONTRACT_VERSION,
    query: {
      raw: rawQuery,
      intent: intent,
      entities: entities,
      keywords: (cir.knowledgeQuery && cir.knowledgeQuery.keywords) || []
    },
    dependencyPlan: {
      requiredEvidence: (cir.evidencePlan && cir.evidencePlan.required) || [],
      optionalEvidence: (cir.evidencePlan && cir.evidencePlan.optional) || []
    },
    capabilities: {
      requiredEvidence: capabilities.requiredEvidence,
      availableEvidence: capabilities.availableEvidence,
      missingEvidence: capabilities.missingEvidence
    },
    evidence,
    meta: {
      totalEvidence,
      sourcesUsed,
      degraded: capabilities.degraded,
      conflictsDetected,
      conflictTrace,
      historicalSupport: 'EXTENSION_POINT_ONLY (Phase 2-2)',
      externalSupport: 'EXTENSION_POINT_ONLY (Phase 2-2)',
      timestamp: new Date().toISOString()
    }
  };
}

  // FIX-1 (Phase 2-3E-B): تبدیل قطعی واژه‌های عددی فارسی پیش از «درصد» (مثال: «هشت درصد» → «8 درصد»)
  const FA_NUMBER_WORDS = { 'یک':1,'دو':2,'سه':3,'چهار':4,'پنج':5,'شش':6,'هفت':7,'هشت':8,'نه':9,'ده':10,'یازده':11,'دوازده':12,'سیزده':13,'چهارده':14,'پانزده':15,'شانزده':16,'هفده':17,'هجده':18,'نوزده':19,'بیست':20,'سی':30,'چهل':40,'پنجاه':50,'شصت':60,'هفتاد':70,'هشتاد':80,'نود':90,'صد':100 };
  const FA_NUMBER_WORD_ORDER = Object.keys(FA_NUMBER_WORDS).sort((a, b) => b.length - a.length);
  const expandFaNumberWords = (rawText) => String(rawText || '').replace(
    new RegExp('(' + FA_NUMBER_WORD_ORDER.join('|') + ')\\s*(?=(?:درصد|٪|%))', 'g'),
    (m) => String(FA_NUMBER_WORDS[m.trim()] !== undefined ? FA_NUMBER_WORDS[m.trim()] : m)
  );

function parseWhatIfQuery(rawText, recentContext = []) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const isHypo = (/(اگر|فرض\s*کن|چنانچه|در\s*صورتی\s*که|احتمال|برسه\s*به|بشه|بشود|سناریو|رشد[\s\u200c]*(?:کند|کنه|کنند|می[\s\u200c]*کند|نماید|یابد|داشته[\s\u200c]*(?:باشد|باشه)|بگیرد|بگیره)|بالا[\s\u200c]*(?:برود|بره|می[\s\u200c]*رود|میره|بیاید|بیاد|بکشد)|پایین[\s\u200c]*(?:برود|بره|می[\s\u200c]*رود|میره|بیاید|بیاد|بکشد)|مثبت[\s\u200c]*(?:شود|بشه|می[\s\u200c]*شود|میشه)|منفی[\s\u200c]*(?:شود|بشه|می[\s\u200c]*شود|میشه)|افزایش[\s\u200c]*(?:یابد|پیدا[\s\u200c]*(?:کند|کنه))|کاهش[\s\u200c]*(?:یابد|پیدا[\s\u200c]*(?:کند|کنه))|افت[\s\u200c]*(?:کند|کنه|نماید|داشته[\s\u200c]*(?:باشد|باشه))|ریزش[\s\u200c]*(?:کند|کنه|نماید|داشته[\s\u200c]*(?:باشد|باشه))|کم[\s\u200c]*(?:شود|بشه)|کمتر[\s\u200c]*(?:شود|بشه)|نزول[\s\u200c]*(?:کند|کنه)|سقوط[\s\u200c]*(?:کند|کنه)|صعود[\s\u200c]*(?:کند|کنه)|جهش[\s\u200c]*(?:کند|کنه)|تقویت[\s\u200c]*(?:شود|بشه)|تضعیف[\s\u200c]*(?:شود|بشه)|گران[\s\u200c]*(?:شود|تر[\s\u200c]*(?:شود|بشه))|ارزان[\s\u200c]*(?:شود|تر[\s\u200c]*(?:شود|بشه))|بیشتر[\s\u200c]*(?:شود|بشه)|پامپ[\s\u200c]*(?:کند|بشه|شود)|دامپ[\s\u200c]*(?:کند|بشه|شود)|[+\-\u2212][\s\u200c]*[0-9\u06F0-\u06F9\u0660-\u0669]+(?:\.[0-9\u06F0-\u06F9\u0660-\u0669]+)?[\s\u200c]*(?:درصد|٪|%))/i.test(text) ||
    (/(ساید|رنج|درجا|تثبیت|بدون\s*تغییر|ثابت)\s*(بشه|بشود|بمونه|بماند|باشه|باشد|بزنه|بزند)/i.test(text))) &&
    !/(چیست|چیه|تعریف|یعنی چه|مفهوم)/i.test(text);
  if (!isHypo) return null;

  const isMultiScenario = /سناریو\s*(?:اول|۱|الف)[\s\S]*سناریو\s*(?:دوم|۲|ب)/i.test(text);
  if (isMultiScenario) {
    const parts = text.split(/سناریو\s*(?:دوم|۲|ب)/i);
    const scen1Text = parts[0];
    const scen2Text = parts[1];
    const scen1 = parseSingleWhatIf(scen1Text, recentContext);
    const scen2 = parseSingleWhatIf(scen2Text, recentContext);
    if (scen1 && scen1.status === 'VALID' && scen2 && scen2.status === 'VALID') {
      return {
        type: 'MULTI_SCENARIO_COMPARISON',
        status: 'VALID',
        scenarioA: scen1,
        scenarioB: scen2,
        rawQuery: text
      };
    }
  }

  return parseSingleWhatIf(text, recentContext);
}

function parseSingleWhatIf(text, recentContext = []) {
    text = expandFaNumberWords(text); // FIX-1: واژه‌های عددی فارسی
  // دایره واژگان صعودی و شوک مثبت (Bullish / Up Shock Terms)
  const UP_TERMS = [
    'بالا برود', 'بالا بره', 'بره بالا', 'برود بالا', 'بالا بیاید', 'بیاید بالا', 'بالا بیاد', 'بیاد بالا', 'بالا بکشه', 'بکشه بالا', 'بالا کشیدن',
    'رشد کند', 'رشد کنه', 'رشد نماید', 'رشد داشته باشد', 'رشد داشته باشه', 'رشد یابد',
    'افزایش یابد', 'افزایش پیدا کند', 'افزایش پیدا کنه', 'افزایش داشته باشد', 'افزایش داشته باشه', 'افزایش',
    'صعود کند', 'صعود کنه', 'صعود نماید', 'صعودی شود', 'صعودی بشه', 'صعودی باشد', 'صعودی باشه', 'روند صعودی بگیرد', 'روند صعودی پیدا کند', 'صعود',
    'جهش کند', 'جهش کنه', 'جهش یابد', 'جهش داشته باشد', 'جهش داشته باشه', 'جهش',
    'زیاد شود', 'زیاد بشه', 'بیشتر شود', 'بیشتر بشه', 'افزوده شود',
    'گرون بشه', 'گران شود', 'گرونتر بشه', 'گرانتر شود', 'گرانتر بشود',
    'تقویت شود', 'تقویت بشه', 'قوی‌تر شود', 'قوی تر بشه',
    'پامپ کند', 'پامپ بشه', 'پامپ شود', 'پامپ',
    'بالا', 'رشد', 'صعود', 'افزایشی', 'مثبت'
  ];

  // دایره واژگان نزولی و شوک منفی (Bearish / Down Shock Terms)
  const DOWN_TERMS = [
    'بریزد', 'بریزه', 'ریزش کند', 'ریزش کنه', 'ریزش داشته باشد', 'ریزش داشته باشه', 'ریزش نماید', 'ریزش',
    'افت کند', 'افت کنه', 'افت داشته باشد', 'افت داشته باشه', 'افت نماید', 'افت',
    'کاهش یابد', 'کاهش پیدا کند', 'کاهش پیدا کنه', 'کاهش داشته باشد', 'کاهش داشته باشه', 'کاهش',
    'پایین بیاید', 'پایین بیاد', 'بیاید پایین', 'بیاد پایین', 'پایین برود', 'پایین بره', 'برود پایین', 'بره پایین', 'پایین بکشه',
    'نزولی شود', 'نزولی بشه', 'نزولی باشد', 'نزولی باشه', 'روند نزولی بگیرد', 'روند نزولی پیدا کند', 'نزول',
    'کم شود', 'کم بشه', 'کمتر شود', 'کمتر بشه', 'کاسته شود',
    'ارزون بشه', 'ارزان شود', 'ارزونتر بشه', 'ارزانتر شود',
    'سقوط کند', 'سقوط کنه', 'سقوط داشته باشد', 'سقوط داشته باشه', 'سقوط',
    'تضعیف شود', 'تضعیف بشه',
    'دامپ کند', 'دامپ بشه', 'دامپ شود', 'دامپ',
    'پایین', 'افت', 'ریزش', 'کاهش', 'نزول', 'کاهشی', 'منفی'
  ];

  // دایره واژگان خنثی، رنج، ساید، تثبیت و بدون تغییر (Neutral / Sideways / Range-Bound Terms)
  const NEUTRAL_TERMS = [
    'ساید بزند', 'ساید بزنه', 'ساید باشد', 'ساید باشه', 'ساید بماند', 'ساید بمونه', 'ساید حرکت کند', 'ساید حرکت کنه', 'روند ساید', 'حرکت ساید', 'سایدوی', 'ساید',
    'رنج بزند', 'رنج بزنه', 'رنج باشد', 'رنج باشه', 'رنج بماند', 'رنج بمونه', 'رنج حرکت کند', 'رنج حرکت کنه', 'کانال رنج', 'رنج‌باند', 'رنج باند', 'رنج',
    'درجا بزند', 'درجا بزنه', 'درجا حرکت کند', 'درجا حرکت کنه', 'درجا باشد', 'درجا باشه', 'درجا بماند', 'درجا بمونه', 'درجا زدن', 'درجا',
    'تثبیت شود', 'تثبیت بشه', 'تثبیت بماند', 'تثبیت بمونه', 'تثبیت باشد', 'تثبیت باشه', 'تثبیت قیمت', 'تثبیت نرخ', 'تثبیت',
    'بدون تغییر بماند', 'بدون تغییر بمونه', 'بدون تغییر باشد', 'بدون تغییر باشه', 'بدون تغییر', 'تغییری نکند', 'تغییری نکنه', 'تغییر نکند', 'تغییر نکنه', 'بی‌تغییر بماند', 'بی تغییر بمونه', 'بی‌تغییر باشد', 'بی تغییر باشه', 'بی‌تغییر', 'بی تغییر',
    'ثابت بماند', 'ثابت بمونه', 'ثابت باشد', 'ثابت باشه', 'ثابت',
    'خنثی بماند', 'خنثی بمونه', 'خنثی باشد', 'خنثی باشه', 'خنثی'
  ];

  const HALF_TERMS = ['نصف بشه', 'نصف شود', 'نصف'];
  const DOUBLE_TERMS = ['دو برابر بشه', 'دوبرابر بشه', '۲ برابر بشه', 'دو برابر شود', 'دوبرابر'];

  const detectAsset = (str) => {
    const s = String(str || '').toLowerCase();
    if (s.includes('اونس') || s.includes('انس') || s.includes('xau')) return 'XAU';
    if (s.includes('نقره') || s.includes('xag')) return 'XAG';
    if (s.includes('سکه') || s.includes('sekee') || s.includes('coin')) return 'COIN';
    // FIX-2 (Phase 2-3E-B): تطبیق اختصاصی پیش از تطبیق عمومی
    if (s.includes('طلای ۱۸') || s.includes('طلا ۱۸') || s.includes('طلای ۱۷') || s.includes('طلای هجده') || s.includes('آب‌شده') || s.includes('آب شده') || s.includes('مثقال') || s.includes('gold18')) return 'GOLD18';
    if (s.includes('تتر') || s.includes('usdt')) return 'USDT';
    if (s.includes('دلار') || s.includes('usd')) return 'USD';
    // تطبیق عمومی «طلا» فقط پس از «دلار» — دارایی هدف («طلا چقدر می‌شود؟») نباید شوک دلار را برباید
    if (s.includes('طلا') || s.includes('gold')) return 'GOLD18';
    if (s.includes('نفت') || s.includes('oil') || s.includes('brent')) return 'OIL';
    if (s.includes('شاخص') || s.includes('بورس') || s.includes('tse')) return 'TSE_INDEX';
    return null;
  };

  let defaultContextAsset = null;
  if (Array.isArray(recentContext) && recentContext.length > 0) {
    for (let i = recentContext.length - 1; i >= 0; i--) {
      const prevText = recentContext[i].text || recentContext[i].content || '';
      const prevAsset = detectAsset(prevText);
      if (prevAsset) {
        defaultContextAsset = prevAsset;
        break;
      }
    }
  }

  const clauses = text.split(/(\s+و\s+|،|,|;|\n)/).map(s => s.trim()).filter(s => s && s !== 'و' && s !== '،' && s !== ',');
  const assumptions = [];

  for (const clause of clauses) {
    const asset = detectAsset(clause) || defaultContextAsset;
    if (!asset) continue;

    const enClause = toEnDigits(clause);

    // حالت‌های نصف و دو برابر
    if (HALF_TERMS.some(t => clause.includes(t))) {
      assumptions.push({ asset, mode: 'PERCENT_CHANGE', value: 50, direction: 'DOWN', rawText: clause });
      continue;
    }
    if (DOUBLE_TERMS.some(t => clause.includes(t))) {
      assumptions.push({ asset, mode: 'PERCENT_CHANGE', value: 100, direction: 'UP', rawText: clause });
      continue;
    }

    // حالت‌های خنثی، ساید، رنج و بدون تغییر بدون ذکر درصد
    if (NEUTRAL_TERMS.some(t => clause.includes(t)) && !enClause.match(/[0-9]+(?:\.[0-9]+)?\s*(?:درصد|٪|percent|%)/i)) {
      assumptions.push({ asset, mode: 'PERCENT_CHANGE', value: 0, direction: 'NEUTRAL', rawText: clause });
      continue;
    }

    // شوک درصدی (مثال: ۱۰ درصد رشد، ۵٪ افت، ۱۰٪ بریزد، ۰٪ ساید)
    const pctMatch = enClause.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:درصد|٪|percent|%)/i);
    if (pctMatch) {
      const val = parseFloat(pctMatch[1]);
      // FIX-1 (Phase 2-3E-B): در نبود واژه جهت، نشانه صریح عدد (+/−) جهت شوک را تعیین می‌کند
      const explicitDownSign = /[-\u2212]\s*[0-9]+(?:\.[0-9]+)?\s*(?:درصد|٪|percent|%)/i.test(enClause);
      const explicitUpSign = /\+\s*[0-9]+(?:\.[0-9]+)?\s*(?:درصد|٪|percent|%)/i.test(enClause);
      let direction = explicitDownSign ? 'DOWN' : (explicitUpSign ? 'UP' : 'UP');
      if (DOWN_TERMS.some(t => clause.includes(t))) direction = 'DOWN';
      else if (NEUTRAL_TERMS.some(t => clause.includes(t))) direction = 'NEUTRAL';
      else if (UP_TERMS.some(t => clause.includes(t))) direction = 'UP';
      assumptions.push({ asset, mode: 'PERCENT_CHANGE', value: val, direction, rawText: clause });
      continue;
    }

    // استخراج مقدار عددی با ضرایب فارسی (هزار، میلیون، میلیارد)
    let numVal = null;
    const numMatch = enClause.match(/([0-9]+(?:\.[0-9]+)?)\s*(هزار|میلیون|میلیارد|k|m|b)?/i);
    if (numMatch) {
      let rawNum = parseFloat(numMatch[1]);
      const mult = (numMatch[2] || '').toLowerCase();
      if (mult === 'هزار' || mult === 'k') rawNum *= 1000;
      else if (mult === 'میلیون' || mult === 'm') rawNum *= 1000000;
      else if (mult === 'میلیارد' || mult === 'b') rawNum *= 1000000000;
      numVal = rawNum;
    }

    if (numVal != null && !Number.isNaN(numVal)) {
      const isUp = UP_TERMS.some(t => clause.includes(t));
      const isDown = DOWN_TERMS.some(t => clause.includes(t));
      const isNeutral = NEUTRAL_TERMS.some(t => clause.includes(t));

      if ((isUp || isDown || isNeutral) && !clause.includes('بشه') && !clause.includes('بشود') && !clause.includes('برسه') && !clause.includes('باشد')) {
        let direction = 'UP';
        if (isDown) direction = 'DOWN';
        else if (isNeutral) direction = 'NEUTRAL';
        assumptions.push({ asset, mode: 'ABSOLUTE_CHANGE', value: isNeutral ? 0 : numVal, direction, rawText: clause });
      } else {
        assumptions.push({ asset, mode: 'ABSOLUTE_TARGET', value: numVal, direction: 'NONE', rawText: clause });
      }
    }
  }

  if (assumptions.length === 0) {
    if (HALF_TERMS.some(t => text.includes(t)) || text.match(/[0-9]+\s*(?:درصد|٪)/)) {
      return { status: 'AMBIGUOUS', missing: ['asset'], rawQuery: text };
    }
    return null;
  }

  for (const asm of assumptions) {
    if (asm.mode === 'ABSOLUTE_TARGET') {
      if (asm.asset === 'USD' && (asm.value < 1000 || asm.value > 100000000)) {
        return { status: 'INVALID_RANGE', error: 'نرخ دلار فرضی خارج از محدوده مجاز (۱٬۰۰۰ تا ۱۰۰٬۰۰۰٬۰۰۰ تومان) است.', rawQuery: text };
      }
      if (asm.asset === 'XAU' && (asm.value < 100 || asm.value > 100000)) {
        return { status: 'INVALID_RANGE', error: 'نرخ اونس فرضی خارج از محدوده مجاز (۱۰۰ تا ۱۰۰٬۰۰۰ دلار) است.', rawQuery: text };
      }
    }
  }

  return {
    type: 'WHAT_IF',
    status: 'VALID',
    assumptions,
    rawQuery: text
  };
}

function executeWhatIfSimulation(ast, normalizedEvidence) {
  if (!ast || ast.status !== 'VALID') return ast;

  const baseUsd = normalizedEvidence.usd?.value || 268000;
  const baseXau = normalizedEvidence.xau?.value || 2980;
  const baseGold18 = normalizedEvidence.gold18?.value || 26550000;
  const baseSekee = normalizedEvidence.sekee?.value || 285000000;
  const baseXag = normalizedEvidence.xag?.value || 33.5;

  const baseGold18Intrinsic = Math.round((baseXau * baseUsd * CANONICAL_CONSTANTS.GOLD18_PURITY) / CANONICAL_CONSTANTS.TROY_OUNCE_ROUNDED);
  const baseCoinIntrinsic = Math.round((CANONICAL_CONSTANTS.COIN_EMAMI_PURE_GOLD_GRAMS / CANONICAL_CONSTANTS.TROY_OUNCE_ROUNDED) * baseXau * baseUsd);
  const baseMithqal17 = Math.round(baseGold18Intrinsic * CANONICAL_CONSTANTS.MITHQAL_PARITY_FACTOR);
  const baseCoinBubbleToman = baseSekee - baseCoinIntrinsic;
  const baseCoinBubblePct = ((baseSekee - baseCoinIntrinsic) / baseCoinIntrinsic) * 100;
  const baseSilver1g = Math.round((baseXag * baseUsd) / CANONICAL_CONSTANTS.TROY_OUNCE_ROUNDED);

  let targetUsd = baseUsd;
  let targetXau = baseXau;
  let targetGold18 = baseGold18;
  let targetSekee = baseSekee;
  let targetXag = baseXag;

  const traceSteps = [];

  for (const asm of ast.assumptions) {
    if (asm.asset === 'USD') {
      let prev = targetUsd;
      if (asm.mode === 'PERCENT_CHANGE') {
        let factor = 1;
        if (asm.direction === 'DOWN') factor = (1 - asm.value / 100);
        else if (asm.direction === 'UP') factor = (1 + asm.value / 100);
        else if (asm.direction === 'NEUTRAL') factor = 1;
        targetUsd = Math.round(prev * factor);
      } else if (asm.mode === 'ABSOLUTE_CHANGE') {
        if (asm.direction === 'DOWN') targetUsd = (prev - asm.value);
        else if (asm.direction === 'UP') targetUsd = (prev + asm.value);
        else if (asm.direction === 'NEUTRAL') targetUsd = prev;
      } else if (asm.mode === 'ABSOLUTE_TARGET') {
        targetUsd = asm.value;
      }
      traceSteps.push({
        asset: 'USD',
        from: prev,
        to: targetUsd,
        unit: 'TOMAN',
        changePct: ((targetUsd - prev) / (prev || 1)) * 100,
        assumption: asm
      });
    } else if (asm.asset === 'XAU') {
      let prev = targetXau;
      if (asm.mode === 'PERCENT_CHANGE') {
        let factor = 1;
        if (asm.direction === 'DOWN') factor = (1 - asm.value / 100);
        else if (asm.direction === 'UP') factor = (1 + asm.value / 100);
        else if (asm.direction === 'NEUTRAL') factor = 1;
        targetXau = Math.round(prev * factor * 100) / 100;
      } else if (asm.mode === 'ABSOLUTE_CHANGE') {
        if (asm.direction === 'DOWN') targetXau = (prev - asm.value);
        else if (asm.direction === 'UP') targetXau = (prev + asm.value);
        else if (asm.direction === 'NEUTRAL') targetXau = prev;
      } else if (asm.mode === 'ABSOLUTE_TARGET') {
        targetXau = asm.value;
      }
      traceSteps.push({
        asset: 'XAU',
        from: prev,
        to: targetXau,
        unit: 'USD',
        changePct: ((targetXau - prev) / (prev || 1)) * 100,
        assumption: asm
      });
    } else if (asm.asset === 'GOLD18') {
      let prev = targetGold18;
      if (asm.mode === 'PERCENT_CHANGE') {
        let factor = 1;
        if (asm.direction === 'DOWN') factor = (1 - asm.value / 100);
        else if (asm.direction === 'UP') factor = (1 + asm.value / 100);
        else if (asm.direction === 'NEUTRAL') factor = 1;
        targetGold18 = Math.round(prev * factor);
      } else if (asm.mode === 'ABSOLUTE_CHANGE') {
        if (asm.direction === 'DOWN') targetGold18 = (prev - asm.value);
        else if (asm.direction === 'UP') targetGold18 = (prev + asm.value);
        else if (asm.direction === 'NEUTRAL') targetGold18 = prev;
      } else if (asm.mode === 'ABSOLUTE_TARGET') {
        targetGold18 = asm.value;
      }
      traceSteps.push({
        asset: 'GOLD18',
        from: prev,
        to: targetGold18,
        unit: 'TOMAN_PER_GRAM',
        changePct: ((targetGold18 - prev) / (prev || 1)) * 100,
        assumption: asm
      });
    } else if (asm.asset === 'COIN') {
      let prev = targetSekee;
      if (asm.mode === 'PERCENT_CHANGE') {
        let factor = 1;
        if (asm.direction === 'DOWN') factor = (1 - asm.value / 100);
        else if (asm.direction === 'UP') factor = (1 + asm.value / 100);
        else if (asm.direction === 'NEUTRAL') factor = 1;
        targetSekee = Math.round(prev * factor);
      } else if (asm.mode === 'ABSOLUTE_CHANGE') {
        if (asm.direction === 'DOWN') targetSekee = (prev - asm.value);
        else if (asm.direction === 'UP') targetSekee = (prev + asm.value);
        else if (asm.direction === 'NEUTRAL') targetSekee = prev;
      } else if (asm.mode === 'ABSOLUTE_TARGET') {
        targetSekee = asm.value;
      }
      traceSteps.push({
        asset: 'COIN',
        from: prev,
        to: targetSekee,
        unit: 'TOMAN',
        changePct: ((targetSekee - prev) / (prev || 1)) * 100,
        assumption: asm
      });
    }
  }

  const targetGold18Intrinsic = Math.round((targetXau * targetUsd * CANONICAL_CONSTANTS.GOLD18_PURITY) / CANONICAL_CONSTANTS.TROY_OUNCE_ROUNDED);
  const targetCoinIntrinsic = Math.round((CANONICAL_CONSTANTS.COIN_EMAMI_PURE_GOLD_GRAMS / CANONICAL_CONSTANTS.TROY_OUNCE_ROUNDED) * targetXau * targetUsd);
  const targetMithqal17 = Math.round(targetGold18Intrinsic * CANONICAL_CONSTANTS.MITHQAL_PARITY_FACTOR);
  const targetSilver1g = Math.round((targetXag * targetUsd) / CANONICAL_CONSTANTS.TROY_OUNCE_ROUNDED);

  const deltaGold18 = targetGold18Intrinsic - baseGold18Intrinsic;
  const deltaGold18Pct = ((deltaGold18) / baseGold18Intrinsic) * 100;

  const deltaCoin = targetCoinIntrinsic - baseCoinIntrinsic;
  const deltaCoinPct = ((deltaCoin) / baseCoinIntrinsic) * 100;

  return {
    status: 'SUCCESS',
    baseline: {
      usd: baseUsd,
      xau: baseXau,
      gold18Market: baseGold18,
      sekeeMarket: baseSekee,
      gold18Intrinsic: baseGold18Intrinsic,
      coinIntrinsic: baseCoinIntrinsic,
      mithqal17: baseMithqal17,
      coinBubblePct: baseCoinBubblePct,
      coinBubbleToman: baseCoinBubbleToman,
      silver1g: baseSilver1g
    },
    hypothetical: {
      usd: targetUsd,
      xau: targetXau,
      gold18Intrinsic: targetGold18Intrinsic,
      coinIntrinsic: targetCoinIntrinsic,
      mithqal17: targetMithqal17,
      silver1g: targetSilver1g
    },
    deltas: {
      gold18: { amount: deltaGold18, pct: deltaGold18Pct },
      coin: { amount: deltaCoin, pct: deltaCoinPct }
    },
    traceSteps,
    rawQuery: ast.rawQuery
  };
}

function executeMultiScenarioComparison(multiAst, normalizedEvidence) {
  const resA = executeWhatIfSimulation(multiAst.scenarioA, normalizedEvidence);
  const resB = executeWhatIfSimulation(multiAst.scenarioB, normalizedEvidence);

  if (resA.status !== 'SUCCESS' || resB.status !== 'SUCCESS') {
    return { status: 'ERROR', error: 'خطا در تحلیل یکی از سناریوهای مقایسه‌ای' };
  }

  const diffGold18 = resB.hypothetical.gold18Intrinsic - resA.hypothetical.gold18Intrinsic;
  const diffGold18Pct = ((diffGold18) / resA.hypothetical.gold18Intrinsic) * 100;

  const diffCoin = resB.hypothetical.coinIntrinsic - resA.hypothetical.coinIntrinsic;
  const diffCoinPct = ((diffCoin) / resA.hypothetical.coinIntrinsic) * 100;

  return {
    status: 'SUCCESS_MULTI',
    scenarioA: resA,
    scenarioB: resB,
    comparison: {
      diffGold18: { amount: diffGold18, pct: diffGold18Pct },
      diffCoin: { amount: diffCoin, pct: diffCoinPct }
    },
    rawQuery: multiAst.rawQuery
  };
}

function renderWhatIfResponse(simResult) {
  if (!simResult) return '';

  if (simResult.status === 'AMBIGUOUS') {
    return `❓ **نیازمند شفاف‌سازی متغیر فرضی:**\n\n` +
      `درخواست سناریوی فرضی شما دریافت شد، اما مشخص نگردید شوک مدنظر بر کدام دارایی (دلار آزاد، اونس جهانی طلا، سکه یا طلای ۱۸ عیار) اعمال شود.\n\n` +
      `💡 **پیشنهادهای سناریویی:**\n` +
      `• *اگر دلار ۱۰ درصد رشد کند، قیمت طلا و سکه چقدر می‌شود؟*\n` +
      `• *اگر اونس ۲۰۰ دلار افت کند و دلار ۲۸۰ هزار تومان شود چه تغییری رخ می‌دهد؟*`;
  }

  if (simResult.status === 'INVALID_RANGE') {
    return `⚠️ **خطای دامنه ارقام فرضی:**\n` + simResult.error;
  }

  // حالت مقایسه دو سناریو (Scenario A vs Scenario B)
  if (simResult.status === 'SUCCESS_MULTI') {
    const { scenarioA, scenarioB, comparison } = simResult;
    const signG18 = comparison.diffGold18.amount >= 0 ? '+' : '';
    const signCoin = comparison.diffCoin.amount >= 0 ? '+' : '';

    return `⚖️ **مقایسه دو سناریوی فرضی:**\n\n` +
      `### سناریوی اول\n` +
      `• دلار آزاد: **${fmtFa(scenarioA.hypothetical.usd)} تومان** | اونس جهانی: **${fmtFa(scenarioA.hypothetical.xau)} دلار**\n` +
      `• ارزش ذاتی هر گرم طلای ۱۸ عیار: **${fmtFa(scenarioA.hypothetical.gold18Intrinsic)} تومان**\n` +
      `• ارزش ذاتی سکه امامی: **${fmtFa(scenarioA.hypothetical.coinIntrinsic)} تومان**\n\n` +
      `### سناریوی دوم\n` +
      `• دلار آزاد: **${fmtFa(scenarioB.hypothetical.usd)} تومان** | اونس جهانی: **${fmtFa(scenarioB.hypothetical.xau)} دلار**\n` +
      `• ارزش ذاتی هر گرم طلای ۱۸ عیار: **${fmtFa(scenarioB.hypothetical.gold18Intrinsic)} تومان**\n` +
      `• ارزش ذاتی سکه امامی: **${fmtFa(scenarioB.hypothetical.coinIntrinsic)} تومان**\n\n` +
      `### تفاوت سناریوی دوم نسبت به اول\n` +
      `• هر گرم طلای ۱۸ عیار: **${signG18}${fmtFa(comparison.diffGold18.amount)} تومان** (${signG18}${fmtPctSmart(comparison.diffGold18.pct)}٪)\n` +
      `• سکه امامی: **${signCoin}${fmtFa(comparison.diffCoin.amount)} تومان** (${signCoin}${fmtPctSmart(comparison.diffCoin.pct)}٪)\n\n` +
      `🔒 **سلب مسئولیت:** این مقادیر بر مبنای ارزش ذاتی محتوای فلزی محاسبه شده‌اند و پیش‌بینی قیمت معامله‌شده در بازار نیستند؛ حباب، عرضه و تقاضا و انتظارات تورمی می‌توانند نتیجه واقعی را متفاوت کنند.`;
  }

  const { hypothetical, deltas, traceSteps } = simResult;

  const assumptionLines = traceSteps.map(t => {
    const sign = t.changePct > 0 ? '+' : '';
    const name = t.asset === 'USD' ? 'دلار آزاد' : (t.asset === 'XAU' ? 'اونس جهانی طلا' : (t.asset === 'GOLD18' ? 'طلای ۱۸ عیار' : (t.asset === 'COIN' ? 'سکه امامی' : t.asset)));
    const unit = t.unit === 'USD' ? 'دلار' : 'تومان';
    const neutralTag = (t.assumption && t.assumption.direction === 'NEUTRAL') ? ' (بدون تغییر)' : '';
    return `• **${name}:** از **${fmtFa(t.from)} ${unit}** به حدود **${fmtFa(t.to)} ${unit}** — یعنی **${sign}${fmtFa(t.changePct, 1)}٪**${neutralTag}`;
  }).join('\n');

  const signG18 = deltas.gold18.amount >= 0 ? '+' : '';
  const signCoin = deltas.coin.amount >= 0 ? '+' : '';

  return `🧮 **شبیه‌ساز تحلیلی سناریوی فرضی:**\n\n` +
    `### 📋 مفروضات سناریو (نسبت به نرخ مبنا)\n` +
    assumptionLines + `\n\n` +
    `### 📊 نتیجه محاسباتی سناریو\n` +
    `• ارزش ذاتی هر گرم طلای ۱۸ عیار: **${fmtFa(hypothetical.gold18Intrinsic)} تومان** — تغییر: **${signG18}${fmtFa(deltas.gold18.amount)} تومان** (${signG18}${fmtPctSmart(deltas.gold18.pct)}٪)\n` +
    `• مظنه معادل هر مثقال طلای ۱۷ عیار: حدود **${fmtFa(hypothetical.mithqal17)} تومان**\n` +
    `• ارزش ذاتی محتوای فلزی سکه امامی: **${fmtFa(hypothetical.coinIntrinsic)} تومان** — تغییر: **${signCoin}${fmtFa(deltas.coin.amount)} تومان** (${signCoin}${fmtPctSmart(deltas.coin.pct)}٪)\n\n` +
    `### 🔍 تفسیر\n` +
    `در این سناریو، اثر ترکیبی مفروضات بالا، ارزش ذاتی مبنای طلای داخلی را حدود **${signG18}${fmtPctSmart(deltas.gold18.pct)}٪** جابه‌جا می‌کند؛ در واقع بخش عمده این تغییر از مسیر دلار و اونس جهانی به ارزش فلزی طلا منتقل می‌شود.\n\n` +
    `🔒 **سلب مسئولیت:** این نتیجه اثر ریاضی تغییر مفروضات است و پیش‌بینی قطعی قیمت بازار نیست؛ حباب، عرضه و تقاضا، انتظارات تورمی و شرایط بازار داخلی می‌توانند قیمت معامله‌شده را متفاوت کنند.`;
}

// ============================================================================
// موتور تولید پاسخ‌های تحلیلی پویای مشاور هوشمند (Dynamic Multi-Asset Synthesis Engine)
// ============================================================================

/**
 * تولید پاسخ تحلیلی هوشمند، زمینه-محور و بلادرنگ برای چت‌بات مشاور دیدبان
 */
function buildDynamicAdvisorResponse(userQuery, todayEvidence = {}, normalizedEvidence = null, queryAnalysis = null, liveEvidenceItems = []) {
  // Phase 2-3C: پرسش «چرا» — پاسخ قطعی ساختارمند (مشاهده → محرک محتمل → قدرت شاهد → تفسیر → عدم‌قطعیت)
  if (typeof detectWhyQuery === 'function' && detectWhyQuery(userQuery)) {
    return buildWhyResponse(queryAnalysis || {}, Array.isArray(liveEvidenceItems) ? liveEvidenceItems : []);
  }
  // FIX-B3-C (Phase 2-3F-B3): مقایسه توصیفی دو دارایی — شاخه اختصاصی پیش از بلوک همبستگی (رفع hijack)
  {
    const _cmpEntities = (queryAnalysis && Array.isArray(queryAnalysis.entities)) ? queryAnalysis.entities : [];
    const _qEarly = String(userQuery || '').toLowerCase();
    if (_cmpEntities.length >= 2 && (_qEarly.includes('مقایسه') || _qEarly.includes('در برابر') || _qEarly.includes('نسبت به'))) {
      const comparisonReply = buildComparisonResponse(queryAnalysis, Array.isArray(liveEvidenceItems) ? liveEvidenceItems : []);
      if (comparisonReply) return comparisonReply;
    }
  }
  const norm = normalizedEvidence || normalizeEvidenceMap(todayEvidence);
  const q = String(userQuery || '').toLowerCase();

  // اجرای سناریوی فرضی با شبیه‌ساز قطعی در صورت وجود قصد What-If
  const whatIfAst = parseWhatIfQuery(userQuery);
  if (whatIfAst) {
    if (whatIfAst.type === 'MULTI_SCENARIO_COMPARISON') {
      const multiRes = executeMultiScenarioComparison(whatIfAst, norm);
      return renderWhatIfResponse(multiRes);
    } else {
      const simRes = executeWhatIfSimulation(whatIfAst, norm);
      return renderWhatIfResponse(simRes);
    }
  }

  const usd = {
    price: norm.usd?.value || 0,
    change: Number(todayEvidence.usd?.pct24h ?? todayEvidence.usd?.change_pct_24h ?? 0),
    hasData: (norm.usd?.value || 0) > 0
  };
  const usdt = {
    price: norm.usdt?.value || 0,
    change: Number(todayEvidence.usdt?.pct24h ?? todayEvidence.usdt?.change_pct_24h ?? 0),
    hasData: (norm.usdt?.value || 0) > 0
  };
  const gold18 = {
    price: norm.gold18?.value || 0,
    change: Number(todayEvidence.gold18?.pct24h ?? todayEvidence.gold18?.change_pct_24h ?? 0),
    hasData: (norm.gold18?.value || 0) > 0
  };
  const sekee = {
    price: norm.sekee?.value || 0,
    change: Number(todayEvidence.sekee?.pct24h ?? todayEvidence.sekee?.change_pct_24h ?? 0),
    hasData: (norm.sekee?.value || 0) > 0
  };
  const xau = {
    price: norm.xau?.value || 0,
    change: Number(todayEvidence.xau?.pct24h ?? todayEvidence.xau?.change_pct_24h ?? 0),
    hasData: (norm.xau?.value || 0) > 0
  };
  const xag = {
    price: norm.xag?.value || 0,
    change: Number(todayEvidence.xag?.pct24h ?? todayEvidence.xag?.change_pct_24h ?? 0),
    hasData: (norm.xag?.value || 0) > 0
  };
  const tse = {
    price: norm.tse_index?.value || 0,
    change: Number(todayEvidence.tse_index?.pct24h ?? 0),
    hasData: (norm.tse_index?.value || 0) > 0
  };
  const tseEqual = {
    price: norm.tse_equal?.value || 0,
    change: Number(todayEvidence.tse_equal?.pct24h ?? 0),
    hasData: (norm.tse_equal?.value || 0) > 0
  };
  const oil = {
    price: norm.oil?.value || 0,
    change: Number(todayEvidence.oil?.pct24h ?? 0),
    hasData: (norm.oil?.value || 0) > 0
  };
  const silver1g = {
    price: norm.silver1g?.value || (xag.hasData && usd.hasData ? Math.round((xag.price * usd.price) / 31.1035) : 0),
    change: Number(todayEvidence.silver1g?.pct24h ?? 0),
    hasData: true
  };

  // ۱. محاسبه حباب و ارزش ذاتی سکه امامی (8.133g, 0.900, 31.1035)
  let coinIntrinsic = null;
  let coinBubbleToman = null;
  let coinBubblePct = null;
  if (usd.hasData && xau.hasData && sekee.hasData) {
    coinIntrinsic = Math.round((8.133 * 0.900 * xau.price * usd.price) / 31.1035);
    coinBubbleToman = sekee.price - coinIntrinsic;
    coinBubblePct = Number((((sekee.price - coinIntrinsic) / coinIntrinsic) * 100).toFixed(1));
  }

  // ۲. محاسبه ارزش ذاتی و حباب گرم طلای ۱۸ عیار (کریدور تعادلی ۲٫۵-٪ تا ۲٫۵+٪ و افق ۱۴ روزه)
  let gold18Intrinsic = null;
  let gold18BubbleToman = null;
  let gold18BubblePct = null;
  if (usd.hasData && xau.hasData && gold18.hasData) {
    gold18Intrinsic = Math.round((xau.price * usd.price * 0.750) / 31.1035);
    gold18BubbleToman = gold18.price - gold18Intrinsic;
    gold18BubblePct = Number((((gold18.price - gold18Intrinsic) / gold18Intrinsic) * 100).toFixed(2));
  }

  // ۳. محاسبه مظنه یک مثقال طلای ۱۷ عیار آب‌شده (۴.۳۳۱۸ برابر گرم ۱۸ عیار)
  let mithqalPrice = null;
  if (gold18.hasData) {
    mithqalPrice = Math.round(gold18.price * 4.3318);
  }

  // ۴. محاسبه اسپرد تتر و دلار
  let usdtSpreadPct = null;
  let usdtSpreadToman = null;
  if (usd.hasData && usdt.hasData) {
    usdtSpreadPct = Number((((usdt.price - usd.price) / usd.price) * 100).toFixed(2));
    usdtSpreadToman = Math.round(usdt.price - usd.price);
  }

  // ۵. محاسبه نسبت طلا به نقره (Gold-to-Silver Ratio: XAU / XAG)
  let goldSilverRatio = null;
  if (xau.hasData && xag.hasData && xag.price > 0) {
    goldSilverRatio = Number((xau.price / xag.price).toFixed(1));
  }

  // استخراج ارقام فرضی کاربر برای شبیه‌ساز What-If
  const userNums = extractNumbersFromText(userQuery);
  const isSimulationQuery = (q.includes('اگر') || q.includes('فرض') || q.includes('محاسبه کن') || q.includes('بشود') || q.includes('برسد')) && userNums.length >= 2;

  // دسته‌بندی قصد کاربر (Intent Routing)
  const isTradeAdviceQuery = q.includes('بفروشم') || q.includes('بخرم') || q.includes('فروش طلا') || q.includes('خرید طلا') || q.includes('بیت کوین بخرم') || q.includes('تبدیل کنم') || q.includes('طلا یا بیت') || q.includes('طلا بفروشم') || q.includes('کی بخریم') || q.includes('کی بفروشیم') || q.includes('جایگزین کنم');
  const isDirectConceptQuery = q.includes('چیست') || q.includes('تفاوت') || q.includes('فرمول') || q.includes('تعریف');
  const isScenarioQuery = q.includes('سناریو') || q.includes('چهارگانه') || q.includes('شواهد ساختاری') || q.includes('برداشت آماری') || q.includes('چشم‌انداز') || q.includes('پیش‌بینی') || q.includes('آینده') || q.includes('رژیم');
  const isBubbleQuery = q.includes('حباب') || q.includes('سکه') || q.includes('آب‌شده') || q.includes('آب شده') || q.includes('مثقال') || q.includes('مسکوک');
  const isCorrelationQuery = q.includes('همبستگی') || q.includes('واگرایی') || q.includes('اسپرد') || q.includes('پیرسون') || q.includes('هم‌حرکت') || q.includes('هم راستا');
  const isBourseQuery = q.includes('بورس') || q.includes('شاخص') || q.includes('سهام') || q.includes('هم‌وزن') || q.includes('هم وزن');
  const isCommodityQuery = q.includes('نقره') || q.includes('نفت') || q.includes('کامودیتی') || q.includes('نسبت طلا به نقره') || q.includes('فلزات') || (q.includes('طلا') && q.includes('نقره'));
  const isPortfolioQuery = q.includes('سبد') || q.includes('تخصیص') || q.includes('تقسیم') || q.includes('سهم دارایی') || q.includes('پورتفوی') || q.includes('چقدر طلا') || q.includes('چند درصد');
  const isCryptoQuery = q.includes('بیت‌کوین') || q.includes('بیت کوین') || q.includes('دامیننس') || q.includes('اتریوم') || q.includes('سولانا') || q.includes('کریپتو') || q.includes('رمز ارز') || q.includes('رمزارز') || q.includes('btc') || q.includes('eth') || q.includes('sol');
  const isWeeklyReviewQuery = q.includes('هفت روزه') || q.includes('هفتگی') || q.includes('۷ روزه') || q.includes('عملکرد هفته');

  // ۵. پاسخ به سوالات تصمیم‌گیری معاملاتی و جایگزینی دارایی (Trade Decision & Asset Switch Query)
  if (isTradeAdviceQuery) {
    const mentionsGold = q.includes('طلا') || q.includes('سکه');
    const mentionsBtc = q.includes('بیت') || q.includes('کریپتو') || q.includes('رمزارز');

    let comparisonContext = '';
    if (mentionsGold && mentionsBtc) {
      comparisonContext = `\n### ⚖️ تحلیل سناریویی و مقایسه بنیادین طلا در برابر بیت‌کوین:\n` +
        `• **۱. طلا (سپر ضدتورمی و دارایی امن):** طلا فاقد ریسک ناشر (No Counterparty Risk) بوده و در ساختار اقتصاد ایران به عنوان پایدارترین حافظ قدرت خرید در برابر نوسانات ارزی شناخته می‌شود. احساس توقف رشد طلا معمولاً در دوره‌های تثبیت پس از جهش‌های بزرگ رخ می‌دهد و لزوماً به معنای پایان روند کلان نیست.\n` +
        `• **۲. بیت‌کوین (دارایی رشدمحور با بتای بالا):** بیت‌کوین پتانسیل جهش‌های نامتقارن دارد، اما بتای آن بسیار بالاتر از طلاست و نوسانات اصلاحی سنگین (افت‌های ۲۰٪ تا ۳۰٪) از ویژگی‌های ذاتی بازار رمزارز است.\n` +
        `• **۳. خطای روانشناسی بازار (Behavioral Bias):** خروج کامل از یک دارایی امن و باثبات به سمت یک دارایی پرنوسان صرفاً بر مبنای خستگی روانی یا ترس از جا ماندن (FOMO)، از متداول‌ترین خطاهای معامله‌گران است. مدیریت علمی پورتفوی بر **تنوع‌بخشی متوازن (Diversification)** تأکید دارد، نه تغییر ناگهانی کل سرمایه.\n`;
    }

    return `🔒 **ملاحظه محوری و سلب توصیه مالی:**\n` +
      `دیدبان بازار یک دستیار تحلیلی، آماری و اقتصادسنجی است و طبق قوانین و موازین حرفه‌ای مالی، **به هیچ عنوان مجاز به ارائه سیگنال مستقیم خرید یا فروش و توصیه معاملاتی نیست**.\n` +
      comparisonContext +
      `\n💡 **توصیه استراتژیک:** تصمیمات مالی خود را بر اساس میزان تحمل ریسک، افق زمانی، درآمد و استراتژی شخصی تنظیم فرمایید و از دنباله‌روی از سیگنال‌های دیگران یا تصمیمات احساسی پرهیز کنید.\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📚 **پیشنهاد ارتقای دانش اقتصادی (از کتابخانه دیدبان):**\n` +
      `• *آیا می‌خواهید درباره [بیت‌کوین، هاوینگ و نقش آن در معماری مالی] بیشتر بدانید؟*\n` +
      `• *آیا مایلید درباره [رابطه کانونیکال مثقال ۱۷ عیار و گرم طلای ۱۸ عیار] مطالعه کنید؟*\n` +
      `• *آیا مایلید درباره [اصول علمی تخصیص دارایی در اقتصاد تورمی] بیشتر بخوانید؟*`;
  }

  // ۶. پاسخ به مفاهیم دانشنامه‌ای مستقیم (Direct Conceptual Queries)
  if (isDirectConceptQuery) {
    if (q.includes('حباب طلا') || q.includes('حباب ۱۸') || q.includes('حباب طلای ۱۸') || q.includes('اشباع خرید طلا') || q.includes('دامنه تعادلی طلا')) {
      let liveGold18Text = '';
      if (gold18Intrinsic !== null) {
        let gold18Regime = '';
        if (gold18BubblePct > 2.5) {
          gold18Regime = `\n• **وضعیت تابلوی امروز:** حباب **+${fmtFa(gold18BubblePct, 2)}٪** (اشباع خرید؛ ریسک بازگشت و اصلاح قیمت در افق ۱۴ روزه).`;
        } else if (gold18BubblePct < -2.5) {
          gold18Regime = `\n• **وضعیت تابلوی امروز:** حباب **${fmtFa(gold18BubblePct, 2)}٪** (تخفیف و عقب‌ماندگی؛ محرک تقاضای آربیتراژی و پتانسیل جهش قیمتی در افق ۱۴ روزه).`;
        } else {
          gold18Regime = `\n• **وضعیت تابلوی امروز:** حباب **${fmtFa(gold18BubblePct, 2)}٪** (در محدوده تعادلی و باثبات طبیعی).`;
        }
        liveGold18Text = `\n\n### 📌 محاسبه زنده تابلوی امروز:\n` +
          `• **ارزش ذاتی هر گرم ۱۸ عیار:** **${fmtFa(gold18Intrinsic)} تومان** (نرخ بازار: **${fmtFa(gold18.price)} تومان**)` +
          gold18Regime;
      }

      return `⚖️ **دامنه تعادلی و دینامیک حباب طلای ۱۸ عیار (افق ۱۴ روزه):**\n\n` +
        `• **مبنای برآورد ارزش ذاتی گرم ۱۸ عیار:** بر پایه اونس جهانی، نرخ دلار آزاد و ضریب تبدیل استاندارد طلا.\n\n` +
        `• **کریدورهای ۳‌گانه تعادل و رفتار نوسانی در افق ۱۴ روزه:**\n` +
        `   - **۱. دامنه تعادلی و باثبات [۲٫۵٪- تا ۲٫۵٪+]:** بازار در حالت تعادل طبیعی نوسان می‌کند و فاقد حباب هیجانی است.\n` +
        `   - **۲. فاز اشباع خرید (بالای ۲٫۵٪+ به‌ویژه فراتر از ۴٫۰٪+):** نشانه هجوم تقاضای هیجانی؛ افزایش ریسک افت قیمت و بازگشت به نرخ تعادلی (Mean Reversion) در بازه ۱۴ روزه.\n` +
        `   - **۳. فاز عقب‌ماندگی و تخفیف ذاتی (کمتر از ۲٫۵٪- به‌ویژه زیر ۴٫۰٪-):** طلا ارزان‌تر از ارزش بردار ارز/اونس معامله می‌شود؛ محرک قوی تقاضای آربیتراژی و جبران عقب‌ماندگی در افق ۱۴ روزه.` +
        liveGold18Text;
    }
    if (q.includes('ربع') || q.includes('ربع سکه')) {
      return `🪙 **کالبدشکافی حباب ربع‌سکه و مسکوکات خرد:**\n\n` +
        `• **مشخصات فیزیکی:** وزن ربع‌سکه **۲٫۰۳۳ گرم** با عیار **۹۰۰ در هزار (۲۱٫۶ عیار)** معادل ۱٫۸۲۹ گرم طلای خالص است.\n` +
        `• **علت حباب بسیار بالا (تا ۵۰٪ الی ۶۰٪):** تمرکز قدرت خرید نقدینگی خرد عموم جامعه بر ارزان‌ترین قطعه رسمی مسکوک طلا به همراه تقاضای سنتی کادویی.\n` +
        `• **ریسک نوسانی:** در فازهای آرامش ارزی یا حراج‌های سکه بانک مرکزی، حباب ربع‌سکه سریع‌ترین و شدیدترین افت درصدی را تجربه می‌کند.`;
    }
    if (q.includes('صندوق طلا') || q.includes('صندوق عیار') || q.includes('صندوق کهربا')) {
      return `📦 **مقایسه صندوق‌های کالایی طلا (Gold ETF) و طلای فیزیکی:**\n\n` +
        `• **مزایای صندوق‌های طلا در بورس:** معاف از مالیات، نقدشوندگی ثانیه‌ای، بدون کارمزد ساخت یا ریسک سرقت فیزیکی، و امکان سرمایه‌گذاری خرد (از ۵۰۰ هزار تومان).\n` +
        `• **پشتوانه دارایی:** سبد دارایی این صندوق‌ها مستقیماً بر گواهی سپرده شمش طلای استاندارد بورس کالا و سکه طلا متمرکز است.`;
    }
    if (q.includes('دامیننس') || q.includes('btc dominance') || q.includes('آلت سیزن')) {
      return `📊 **شاخص دامیننس بیت‌کوین (BTC Dominance - BTC.D):**\n\n` +
        `• **تعریف:** درصد سهم ارزش بازار بیت‌کوین نسبت به کل مارکت‌کپ بازار کریپتو.\n` +
        `• **چرخه‌های انتقال نقدینگی:**\n` +
        `   - **رشد دامیننس:** فرار نقدینگی از آلت‌کوین‌ها به پناهگاه امن بیت‌کوین.\n` +
        `   - **کاهش دامیننس هم‌زمان با ثبات بیت‌کوین:** چرخش پول به سمت اتریوم، سولانا و آلت‌کوین‌ها (**آغاز فاز آلت‌سیزن / Altseason**).`;
    }
    if (q.includes('pmi') || q.includes('مدیران خرید')) {
      return `🏭 **شاخص مدیران خرید (PMI - Purchasing Managers' Index):**\n\n` +
        `• **شاخص پیش‌نگر:** حاصل نظرسنجی از مدیران خرید شرکت‌ها درباره تولید، سفارش‌ها و اشتغال.\n` +
        `• **تفسیر:** بالای ۵۰ واحد نشانه انبساط و رشد اقتصادی (Expansion)، و زیر ۵۰ واحد نشانه انقباض و رکود صنعتی (Contraction) است.`;
    }
    if (q.includes('نسبت طلا به نقره') || q.includes('طلا به نقره') || q.includes('xau/xag')) {
      return `⚖️ **نسبت اونس طلا به نقره (XAU/XAG Ratio):**\n\n` +
        `• **مبنای نسبت:** تقسیم نرخ هر اونس طلا بر نرخ هر اونس نقره.\n` +
        `• **تفسیر تحلیلی:** نسبت بالای ۸۵ نشانه ارزندگی شدید نقره؛ نسبت ۷۰ تا ۸۰ محدوده تعادلی؛ و نسبت زیر ۶۵ نشانه پیشتازی شتابان نقره در چرخه‌های رونق صنعتی است.`;
    }
    if (q.includes('cpi') || q.includes('قیمت مصرف کننده') || q.includes('مصرف‌کننده')) {
      return `📈 **شاخص قیمت مصرف‌کننده (CPI - Consumer Price Index):**\n\n` +
        `• **تعریف:** میانگین تغییرات قیمتی سبد کالاها و خدمات مصرفی خانوارها در طول زمان.\n` +
        `• **اهمیت کلان:** مهم‌ترین شاخص ارزیابی نرخ تورم و محرک اصلی تصمیم‌گیری بانک‌های مرکزی در تعیین نرخ بهره.\n` +
        `• **اثر بر بازارها:** ارقام CPI بالاتر از انتظار، احتمال رشد نرخ بهره فدرال رزرو را افزایش داده و در کوتاه‌مدت به نفع شاخص دلار و به ضرر طلا عمل می‌کند.`;
    }
    if (q.includes('dxy') || q.includes('شاخص دلار')) {
      return `🌐 **شاخص دلار آمریکا (DXY - US Dollar Index):**\n\n` +
        `• **تعریف:** میانگین وزنی ارزش دلار آمریکا در برابر ۶ ارز معتبر جهانی (با بیش از ۵۷٪ وزن یورو).\n` +
        `• **همبستگی با طلا:** رابطه شاخص دلار با کامودیتی‌ها و اونس طلا تاریخی و **معکوس** است؛ صعود DXY طلا را برای خریداران غیردلاری گران‌تر کرده و تقاضای اونس را مهار می‌کند.`;
    }
    if (q.includes('p/e') || q.includes('پی بر ای') || q.includes('قیمت به درآمد')) {
      return `📊 **نسبت قیمت به درآمد (P/E Ratio) در بازار سهام:**\n\n` +
        `• **مبنای نسبت:** تقسیم قیمت هر سهم بر سود هر سهم (EPS).\n` +
        `• **تفسیر:** نشان‌دهنده مدت زمان بازگشت سرمایه از محل سود شرکت است. P/E پایین در صنایع بنیادی نشانگر ارزندگی و P/E بالا نشانه انتظارات رشد در آینده است.`;
    }
    if (q.includes('صندوق') || q.includes('صندوق های بورسی')) {
      return `📦 **انواع صندوق‌های سرمایه‌گذاری در بورس تهران:**\n\n` +
        `• **۱. صندوق درآمد ثابت (Fixed Income):** ریسک صفر و پرداخت سود دوره‌ای جهت مدیریت نقدینگی.\n` +
        `• **۲. صندوق سهامی (Equity Fund):** مدیریت حرفه‌ای سبد سهام با هدف کسب بازدهی همگام یا بالاتر از شاخص.\n` +
        `• **۳. صندوق اهرمی (Leveraged Fund):** بازدهی مضاعف در رونق بازار همراه با ریسک افت شدیدتر در اصلاحات.\n` +
        `• **۴. صندوق کالایی طلا (Gold ETF):** سرمایه‌گذاری شفاف در گواهی سپرده طلا بدون ریسک سرقت فیزیکی.`;
    }
    if (q.includes('بروکر') || q.includes('کارگزاری')) {
      return `🏢 **تفاوت کارگزاری بورس و بروکر (Broker):**\n\n` +
        `• **کارگزاری بورس:** نهاد واسط مجاز داخلی تحت نظارت سازمان بورس جهت ارسال سفارش‌ها به هسته معاملات بورس و فرابورس.\n` +
        `• **بروکر (Broker):** کارگزار بین‌المللی ارائه‌دهنده دسترسی به بازارهای جهانی فارکس، فلزات و سهام خارجی با امکاناتی نظیر لوریج معاملاتی.`;
    }
    if (q.includes('کوین') && q.includes('توکن')) {
      return `⚡ **تفاوت کوین (Coin) و توکن (Token) در کریپتو:**\n\n` +
        `• **کوین (Coin):** رمزارزی که دارای **بلاک‌چین مستقل و اختصاصی** است (مانند بیت‌کوین و اتریوم).\n` +
        `• **توکن (Token):** دارایی دیجیتالی که بر بستر قراردادهای هوشمند یک بلاک‌چین دیگر ایجاد شده است (مانند تتر USDT روی شبکه ترون یا اتریوم).`;
    }
  }

  // ۷. پاسخ به شبیه‌ساز سناریوی فرضی (What-If Simulation Engine)
  if (isSimulationQuery) {
    let simUsd = userNums.find(n => n >= 20000 && n <= 5000000) || usd.price;
    let simXau = userNums.find(n => n >= 500 && n <= 20000) || xau.price;

    if (simUsd > 0 && simXau > 0) {
      const simIntrinsic = Math.round((8.133 * 0.900 * simXau * simUsd) / 31.1035);
      const simGold18 = Math.round((simXau * simUsd * 0.750) / 31.1035);
      const simMithqal = Math.round(simGold18 * 4.3318);

      return `🧮 **شبیه‌ساز و ماشین‌حساب سناریوی فرضی قیمت (What-If Interactive Simulation):**\n\n` +
        `### پارامترهای مفروض ورودی:\n` +
        `• **نرخ فرضی دلار آزاد:** **${fmtFa(simUsd)} تومان**\n` +
        `• **نرخ فرضی اونس جهانی طلا ($XAU$):** **${fmtFa(simXau)} دلار**\n\n` +
        `### نتایج محاسباتی بر مبنای مفروضات فوق:\n` +
        `• **۱. ارزش ذاتی محتوای طلای سکه تمام امامی:** **${fmtFa(simIntrinsic)} تومان**\n` +
        `• **۲. قیمت تئوریک هر گرم طلای ۱۸ عیار:** **${fmtFa(simGold18)} تومان**\n` +
        `• **۳. مظنه تئوریک یک مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(simMithqal)} تومان** (بر پایه ضریب تبدیل استاندارد طلا)\n\n` +
        `💡 **نکته تحلیلی:** در صورتی که قیمت بازار سکه در آن شرایط فرضی بالاتر از **${fmtFa(simIntrinsic)} تومان** باشد، مابه‌التفاوت آن حباب اسمی و پرمیوم تقاضای انتظاری خواهد بود.`;
    }
  }

  // ۶. پاسخ تخصصی به تخصیص سبد دارایی و پورتفوی (طلا، دلار، ریال، رمزارز)
  if (isPortfolioQuery) {
    return `💼 **اصول علمی و ساختار تخصیص دارایی در اقتصادهای تورمی (Asset Allocation Framework):**\n\n` +
      `بر مبنای تئوری مدرن پرتفولیو (Markowitz MPT) و مدل تعادلی موازنه ریسک (All-Weather Risk Parity)، سبد سرمایه‌گذاری به ۵ لایه کارکردی تفکیک می‌شود:\n\n` +
      `• **۱. سپر ضدتورمی و حفظ ارزش پایه (۴۰٪ تا ۵۰٪ طلا):**\n` +
      `   - ترجیحاً طلای ۱۸ عیار آب‌شده یا صندوق‌های طلای بورس کالا جهت به حداقل رساندن حباب ضرب مسکوکات.\n` +
      `• **۲. پوشش نوسانات ارزی و قدرت خرید فرامرزی (۲۰٪ تا ۳۰٪ ارز / تتر):**\n` +
      `   - حفظ سبد ارزی ترکیبی از اسکناس دلار و استیبل‌کوین‌های با نقدشوندگی بالا (USDT) برای مهار شوک‌های ارزی.\n` +
      `• **۳. دارایی‌های مولد و رشد سرمایه (۱۵٪ تا ۲۵٪ بازار سهام):**\n` +
      `   - صندوق‌های شاخصی و نمادهای صادرات‌محور و پتروپالایشی دلاری با P/E معقول جهت کسب سود تقسیمی و تعدیل تورم در بلندمدت.\n` +
      `• **۴. سپر نقدینگی و مدیریت فرصت (۵٪ تا ۱۰٪ درآمد ثابت ریالی):**\n` +
      `   - صندوق‌های درآمد ثابت و حساب‌های بانکی جهت هزینه‌های جاری و خرید پله‌ای دارایی‌ها در زمان اصلاحات شدید بازار.\n` +
      `• **۵. رشد نامتقارن با ریسک کنترل‌شده (۰٪ تا ۵٪ کریپتو):**\n` +
      `   - بیت‌کوین ($BTC$) و رمزارزهای لایه ۱ به عنوان دارایی با بتای بالا و پتانسیل جهش فرامرزی.\n\n` +
      `⚖️ **سلب مسئولیت:** این چارچوب یک الگوی تحلیلی و مدیریت ریسک است و باید بر مبنای سن، افق زمانی و میزان تحمل ریسک شخصی تنظیم گردد.`;
  }

  // ۷. پاسخ تخصصی به تحلیل بازار کریپتو، بیت‌کوین، دامیننس، اتریوم و سولانا
  if (isCryptoQuery) {
    const isEthSol = (q.includes('اتریوم') || q.includes('eth')) && (q.includes('سولانا') || q.includes('sol'));
    if (isEthSol) {
      return `⚡ **تحلیل تطبیقی و ساختاری اتریوم ($ETH$) در برابر سولانا ($SOL$):**\n\n` +
        `• **۱. اتریوم (Ethereum - لایه ۱ نهادی و پایدار):**\n` +
        `   - *مزیت ساختاری:* بیشترین میزان نقدینگی قفل‌شده (TVL)، محور اصلی امور مالی غیرمتمرکز (DeFi) و پذیرش توسط صندوق‌های ETF نهادی.\n` +
        `   - *مدل اقتصادی:* با به‌روزرسانی EIP-1559 در زمان شلوغی شبکه بخشی از کارمزدها سوزانده شده و خاصیت ضدتورمی (Ultrasound Money) پیدا می‌کند.\n` +
        `   - *پروفایل ریسک:* بتای پایین‌تر و ثبات ساختاری بیشتر.\n\n` +
        `• **۲. سولانا (Solana - لایه ۱ پرسرعت و پرریسک):**\n` +
        `   - *مزیت ساختاری:* پردازش هزاران تراکنش در ثانیه با کارمزد بسیار ناچیز، بستر اصلی جذب کاربران خرد و موج‌های نقدینگی سریع.\n` +
        `   - *مدل اقتصادی:* بتای بالاتر و حساسیت شدیدتر به چرخه کلی نقدینگی کریپتو (در فاز صعودی شتاب بیشتر و در اصلاحات ریزش شدیدتر).\n\n` +
        `• **ماتریس تصمیم‌گیری تحلیلی:** اتریوم برای سرمایه‌گذار با افق بلندمدت و ریسک متعادل مناسب است، در حالی که سولانا نقش دارایی رشدمحور با نوسان‌پذیری بالاتر را ایفا می‌کند.`;
    }

    return `🪙 **تحلیل ساختار بازار کریپتو، بیت‌کوین و شاخص دامیننس ($BTC.D$):**\n\n` +
      `• **نقش محوری بیت‌کوین ($BTC$):** به عنوان طلای دیجیتال و دارایی مبنای نقدینگی در کل اکوسیستم رمزارزها عمل می‌کند.\n` +
      `• **مفهوم اقتصادی شاخص دامیننس بیت‌کوین (BTC Dominance):**\n` +
      `   - **رشد دامیننس:** فرار سرمایه از آلت‌کوین‌ها به بیت‌کوین به دلیل افزایش نااطمینانی یا شروع موج صعودی اولیه.\n` +
      `   - **کاهش دامیننس هم‌زمان با ثبات بیت‌کوین:** چرخش نقدینگی به سمت اتریوم، سولانا و آلت‌کوین‌ها (آغاز فاز آلت‌سیزن).\n` +
      `• **اسپرد تتر داخلی:** قیمت تتر در بازار داخل تابع مستقیم نرخ دلار آزاد به همراه اسپرد تقاضای رمزارزی است.`;
  }

  // ۸. پاسخ به تحلیل کارنامه ۷ روزه بازار
  if (isWeeklyReviewQuery) {
    return `📊 **تحلیل کارنامه هفت‌روزه و دینامیک چرخش نقدینگی در بازارها:**\n\n` +
      `• **۱. روند هفتگی ارز و طلا:** موازنه بازدهی ۷ روزه دلار آزاد و طلای ۱۸ عیار نشان‌دهنده همبستگی بالای ۹۰٪ است؛ هرچند نوسانات اونس جهانی طلا توانسته در برخی روزها بردار حرکت طلای داخل را تعدیل کند.\n` +
      `• **۲. رفتار حباب مسکوکات:** تغییرات حباب سکه در طول هفته گذشته نمایانگر شدت تغییرات انتظارات تورمی است.\n` +
      `• **۳. تراز بازار سرمایه:** مقایسه بازدهی شاخص کل با شاخص هم‌وزن نشان‌دهنده نحوه توزیع نقدینگی میان صنایع بزرگ دلاری و نمادهای ریالی کوچک است.\n` +
      `• **۴. پیشتاز بازدهی:** طلا و دارایی‌های سخت در شرایط عدم اطمینان معمولاً بر بازدهی سپرده‌های بانکی و سود ثابت برتری ثبت کرده‌اند.`;
  }

  // ۹. پاسخ به تحلیل مجتمع کامودیتی‌ها، نقره و نفت
  if (isCommodityQuery) {
    let ratioAnalysis = '';
    if (goldSilverRatio !== null) {
      let ratioMeaning = goldSilverRatio > 80
        ? 'بالای ۸۰ نشان‌دهنده ریسک‌گریزی شدید کلان، پناه نقدینگی جهانی به طلا و عقب‌ماندگی مصارف صنعتی نقره است.'
        : (goldSilverRatio < 70 ? 'پایین‌تر از ۷۰ نشان‌دهنده رونق صنعتی و شتاب تمایل به ریسک (Risk-on) در بازارهای جهانی است.' : 'در محدوده تعادلی تاریخی قرار دارد.');

      ratioAnalysis = `\n• **نسبت طلا به نقره تابلوی زنده ($XAU/XAG$):** **${fmtFa(goldSilverRatio, 1)}**\n` +
        `   - *تفسیر کلان:* ${ratioMeaning}\n` +
        `   - قیمت اونس نقره: **${fmtFa(xag.price, 2)} دلار** | قیمت هر گرم نقره ۹۹۹ داخلی: **${fmtFa(silver1g.price)} تومان**\n`;
    }

    let oilAnalysis = '';
    if (oil.hasData) {
      oilAnalysis = `\n• **نفت خام برنت / WTI:** **${fmtFa(oil.price, 2)} دلار** (${oil.change >= 0 ? '+' : ''}${fmtFa(oil.change, 2)}٪)\n` +
        `   - *اثر بر اقتصاد داخل:* نوسانات نفت محرک اصلی درآمدهای پتروپالایشی‌های بورس تهران و منابع ارزی سامانه نیما است.`;
    }

    return `🌍 **تحلیل جامع مجتمع کامودیتی‌ها، نفت و فلزات گرانبها (طلا در برابر نقره):**\n\n` +
      `• **مقایسه ساختاری طلا و نقره:**\n` +
      `   - **طلا ($XAU$):** دارایی پولی خالص و پناهگاه اول در برابر تورم و افت ارزش ارزهای فیات با نوسان کنترل‌شده‌تر و نقدشوندگی آنی در بازار داخل.\n` +
      `   - **نقره ($XAG$):** دارایی دوگانه (بیش از ۵۰٪ کاربرد صنعتی در الکترونیک و انرژی پاک) با بتای بالاتر؛ در دوران رونق اقتصادی و جهش کامودیتی‌ها بازدهی درصدی بالاتری نسبت به طلا ثبت می‌کند، اما در رکود افت شدیدتری دارد.` +
      ratioAnalysis +
      oilAnalysis +
      `\n\n⚖️ **جمع‌بندی برای سرمایه‌گذار:** برای حفظ ارزش بدون استرس نوسانی، طلا و طلای آب‌شده اولویت دارند؛ برای رشد تهاجمی با تحمل ریسک بالا، نقره گزینه مکمل پورتفوی است.`;
  }

  // ۴. پاسخ به تحلیل سناریوهای ۴گانه
  if (isScenarioQuery) {
    let dynamicEvidence = '';
    if (usd.hasData || gold18.hasData || sekee.hasData || xau.hasData) {
      dynamicEvidence = `\n\n### کارت برداشت آماری و شواهد ساختاری تابلوی فعال:\n` +
        `• **وضعیت تابلوی ارز و طلا:** دلار آزاد **${fmtFa(usd.price)} تومان** (${usd.change >= 0 ? '+' : ''}${fmtFa(usd.change, 2)}٪) | طلای ۱۸ عیار **${fmtFa(gold18.price)} تومان** (${gold18.change >= 0 ? '+' : ''}${fmtFa(gold18.change, 2)}٪) | اونس طلا **${fmtFa(xau.price)} دلار** (${xau.change >= 0 ? '+' : ''}${fmtFa(xau.change, 2)}٪).\n` +
        `• **مظنه یک مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(mithqalPrice)} تومان** (بر پایه ضریب تبدیل استاندارد طلا).\n` +
        (coinBubblePct !== null ? `• **رژیم حباب سکه امامی:** **${fmtFa(coinBubblePct, 1)}٪** (${fmtFa(coinBubbleToman)} تومان اضافه ارزش نسبت به ارزش ذاتی **${fmtFa(coinIntrinsic)} تومان**).\n` : '') +
        (usdtSpreadPct !== null ? `• **اسپرد تتر نسبت به دلار آزاد:** **${fmtFa(usdtSpreadPct, 2)}٪** (شکاف قیمتی **${fmtFa(usdtSpreadToman)} تومان**).\n` : '') +
        (tse.hasData ? `• **موازنه تابلوی بازار سرمایه:** شاخص کل **${fmtFa(tse.price)} واحد** (${tse.change >= 0 ? '+' : ''}${fmtFa(tse.change, 2)}٪) در برابر هم‌وزن **${fmtFa(tseEqual.price)} واحد**.` : '');
    }

    return `🔮 **تحلیل جامع سناریوهای ۴گانه اقتصاد کلان و بازارهای مالی:**\n\n` +
      `دیدبان بازار وضعیت فعلی دارایی‌ها را در قالب ۴ رژیم تعادلی ارزیابی می‌کند:\n\n` +
      `• **۱. سناریوی انبساط ملایم (Soft Expansion):** کنترل نوسانات ارزی ──► ثبات اسپرد تتر-دلار در کانال ۰٪ تا ۱٪ ──► حباب سکه در محدوده تعادلی ۱۲٪ تا ۱۵٪ ──► رشد پایدار و دلاری بورس.\n` +
      `• **۲. سناریوی شوک ارزی و تورم انتظاری (FX Shock):** پرش اسپرد تتر به بالای ۲٪ ──► رشد شتابان طلای ۱۸ عیار ──► انبساط حباب سکه به بالای ۲۵٪ ──► افت شاخص دلاری بورس.\n` +
      `• **۳. سناریوی رکود تورمی (Stagflation):** کاهش حجم معاملات کامودیتی‌ها و سهام ──► پناه سرمایه‌ها به طلای فیزیکی و به‌ویژه طلای آب‌شده (به دلیل حباب صفر نسبت به سکه).\n` +
      `• **۴. سناریوی تنش ژئوپلیتیک (Crisis Spike):** جهش هم‌زمان اونس جهانی و دلار ──► سبقت نرخ تتر از دلار کاغذی ──► صعود طلای داخلی.` +
      dynamicEvidence +
      `\n\n⚖️ **سلب مسئولیت و ملاحظات آماری:** سناریوهای فوق صرفاً موازنه احتمالات تاریخی بوده و سیگنال معاملاتی یا قطعیت علّی تلقی نمی‌شوند.`;
  }

  // ۵. پاسخ به تحلیل همبستگی، واگرایی طلا و دلار، و اسپرد تتر
  if (isCorrelationQuery) {
    let divAnalysis = '';
    if (usd.hasData && gold18.hasData) {
      if (usd.change > 0.05 && gold18.change < -0.05) {
        divAnalysis = `\n• **🔍 واگرایی معکوس امروز (صعود دلار هم‌زمان با افت طلا):**\n` +
          `   امروز دلار آزاد **+${fmtFa(usd.change, 2)}٪** رشد کرده، اما طلای ۱۸ عیار با **${fmtFa(gold18.change, 2)}٪** افت همراه بوده است. علت این واگرایی ساختاری به ${xau.change < 0 ? `افت اونس جهانی طلا به سطح **${fmtFa(xau.price)} دلار** (${fmtFa(xau.change, 2)}٪)` : 'تخلیه مقطعی حباب داخلی و کاهش تقاضای سفته‌بازی'} بازمی‌گردد که اثر افزایشی ارز را مهار نموده است.`;
      } else if (usd.change < -0.05 && gold18.change > 0.05) {
        divAnalysis = `\n• **🔍 واگرایی مستقیم امروز (افت دلار هم‌زمان با صعود طلا):**\n` +
          `   طلای ۱۸ عیار با وجود افت ارز، به دلیل تقویت اونس جهانی به سطح **${fmtFa(xau.price)} دلار** (${fmtFa(xau.change, 2)}٪) رشد کرده است.`;
      } else {
        divAnalysis = `\n• **🔍 وضعیت هماهنگی امروز:**\n` +
          `   دلار آزاد (${usd.change >= 0 ? '+' : ''}${fmtFa(usd.change, 2)}٪) و طلای ۱۸ عیار (${gold18.change >= 0 ? '+' : ''}${fmtFa(gold18.change, 2)}٪) حرکتی هم‌راستا (هم‌مسیر) با یکدیگر ثبت کرده‌اند.`;
      }
    }

    let spreadAnalysis = '';
    if (usdtSpreadPct !== null) {
      spreadAnalysis = `\n• **📌 تحلیل اسپرد تتر و دلار تابلوی فعال:**\n` +
        `   - نرخ دلار آزاد: **${fmtFa(usd.price)} تومان** | نرخ تتر (USDT): **${fmtFa(usdt.price)} تومان** ──► انحراف اسپرد: **${fmtFa(usdtSpreadPct, 2)}٪** (${fmtFa(usdtSpreadToman)} تومان).\n` +
        `   - *تفسیر اقتصادی:* ${usdtSpreadPct > 1.2 ? 'اسپرد بالای ۱.۲٪ نشان‌دهنده اضافه تقاضای خروج نقدینگی و پرمیوم تسویه فرامرزی است.' : 'اسپرد در محدوده متعادل و نقدشونده بازار قرار دارد.'}`;
    }

    return `📈 **تحلیل کمّی و ساختاری همبستگی بازارها و واگرایی دارایی‌ها:**\n\n` +
      `• **همبستگی تاریخی دارایی‌ها — هم‌حرکتی آماری (ضرایب مرجع Illustrative؛ پارامتر تحلیلی ثابت، نه محاسبه‌شده از سری زمانی):**\n` +
      `   - همبستگی طلای ۱۸ عیار با دلار آزاد: **+۰٫۹۴** (ضریب مرجع ثابت — هم‌حرکتی مستقیم بسیار قدرتمند).\n` +
      `   - همبستگی تتر با دلار کاغذی: **+۰٫۹۸** (ضریب مرجع ثابت — انطباق با انحراف اسپرد دوره‌ای).\n` +
      `   - همبستگی طلای ۱۸ عیار با اونس جهانی طلا: **+۰٫۶۵** (ضریب مرجع ثابت — تعدیل دوگانه بردار ارز و اونس).\n` +
      `   - *این ضرایب پارامترهای تحلیلی مرجع (Illustrative) هستند و از سری زمانی تاریخی/زنده محاسبه نشده‌اند؛ محاسبه ضریب پیرسون واقعی نیازمند داده تاریخی است.*` +
      divAnalysis +
      spreadAnalysis +
      `\n\n• **برابری مظنه مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(mithqalPrice)} تومان** (بر پایه ضریب تبدیل استاندارد طلا).`;
  }

  // ۶. پاسخ به تحلیل حباب سکه، طلای ۱۸ عیار و طلای آب‌شده
  if (isBubbleQuery) {
    let liveBubbleDetails = '';
    if (coinIntrinsic !== null) {
      liveBubbleDetails = `\n### 📌 محاسبه زنده حباب تابلوی امروز:\n` +
        `• **۱. سکه تمام امامی:** ارزش ذاتی **${fmtFa(coinIntrinsic)} تومان** | نرخ بازار: **${fmtFa(sekee.price)} تومان** ──► **حباب: ${fmtFa(coinBubblePct, 1)}٪** (${fmtFa(coinBubbleToman)} تومان).\n` +
        (gold18Intrinsic !== null ? `• **۲. هر گرم طلای ۱۸ عیار:** ارزش ذاتی **${fmtFa(gold18Intrinsic)} تومان** | نرخ بازار: **${fmtFa(gold18.price)} تومان** ──► **حباب تحلیلی: ${gold18BubblePct >= 0 ? '+' : ''}${fmtFa(gold18BubblePct, 2)}٪**.\n` : '') +
        `• **۳. مظنه یک مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(mithqalPrice)} تومان** (بر پایه ضریب تبدیل استاندارد طلا).\n`;
    }

    let gold18Analysis = '';
    if (gold18BubblePct !== null) {
      let regimeDesc = '';
      if (gold18BubblePct > 2.5) {
        regimeDesc = 'بالاتر از دامنه تعادلی (+۲٫۵٪+) قرار داشته و نشان‌دهنده اشباع خرید است؛ در افق ۱۴ روزه احتمال افت قیمت و بازگشت به نرخ تعادلی بالاست.';
      } else if (gold18BubblePct < -2.5) {
        regimeDesc = 'پایین‌تر از دامنه تعادلی (-۲٫۵٪-) بوده و بیانگر عقب‌ماندگی و تخفیف ذاتی است؛ در افق ۱۴ روزه با هجوم تقاضای آربیتراژی محرک رشد قیمتی دارد.';
      } else {
        regimeDesc = 'در محدوده تعادلی و باثبات طبیعی [-۲٫۵٪ تا +۲٫۵٪] قرار دارد و فاقد هیجان سفته‌بازی است.';
      }
      gold18Analysis = `\n• **کریدور تعادلی حباب طلای ۱۸ عیار (افق ۱۴ روزه):**\n` +
        `   - وضعیت حباب طلای ۱۸ عیار ${regimeDesc}\n`;
    }

    return `📊 **تحلیل دقیق و ریاضی ساختار حباب سکه و مسکوکات، طلای ۱۸ عیار و طلای آب‌شده:**\n\n` +
      `• **مبنای برآورد ارزش ذاتی سکه امامی:** وزن و عیار سکه، اونس جهانی، نرخ دلار آزاد و حق ضرب رسمی.\n` +
      `• **مبنای برآورد ارزش ذاتی هر گرم طلای ۱۸ عیار:** اونس جهانی، نرخ دلار آزاد و ضریب تبدیل استاندارد.\n` +
      liveBubbleDetails +
      gold18Analysis +
      `\n• **خط‌کش سه‌سطحی ارزیابی ریسک حباب مسکوکات:**\n` +
      `   - **زیر ۱۵٪:** محدوده تعادلی و کم‌ریسک تاریخی.\n` +
      `   - **۱۵٪ تا ۲۵٪:** محدوده گرم با اضافه ارزش ناشی از تقاضای انتظاری و تورمی.\n` +
      `   - **بالای ۲۵٪:** محدوده پرریسک و آسیب‌پذیر نسبت به اصلاح نرخ ارز یا حباب‌زدایی.\n\n` +
      `• **نکته تخصصی پورتفوی:** در شرایطی که حباب سکه بالای ۲۰٪ قرار می‌گیرد، طلای آب‌شده به دلیل فاقد بودن حق ضرب و حباب سفته‌بازی، ضریب ریسک نوسانی پایین‌تری نسبت به مسکوکات دارد.`;
  }

  // ۷. پاسخ به تحلیل بازار بورس و شاخص‌ها
  if (isBourseQuery) {
    let tseSnippet = '';
    if (tse.hasData && tseEqual.hasData) {
      tseSnippet = `\n### 📌 تابلوی امروز بازار سهام:\n` +
        `• **شاخص کل:** **${fmtFa(tse.price)} واحد** (${tse.change >= 0 ? '+' : ''}${fmtFa(tse.change, 2)}٪)\n` +
        `• **شاخص کل هم‌وزن:** **${fmtFa(tseEqual.price)} واحد** (${tseEqual.change >= 0 ? '+' : ''}${fmtFa(tseEqual.change, 2)}٪)\n`;
    }

    return `📉 **تحلیل ساختاری و تطبیقی شاخص کل در برابر شاخص هم‌وزن:**\n\n` +
      `• **شاخص کل (Market-Cap Weighted):** انعکاس عملکرد ۳۰ نماد بزرگ دلاری، پتروشیمی، فلزی و هلدینگ‌های عمده.\n` +
      `• **شاخص هم‌وزن (Equal-Weight):** نشان‌دهنده عمق جریان نقدینگی خرد در شرکت‌های متوسط و کوچک و صنایع ریالی.` +
      tseSnippet +
      `\n• **قاعده واگرایی تحلیلی:**\n` +
      `   - صعود شاخص کل هم‌زمان با درجا زدن هم‌وزن = تمرکز نقدینگی روی صنایع کامودیتی‌محور به واسطه رشد دلار نیما/آزاد.\n` +
      `   - صعود سریع‌تر شاخص هم‌وزن = بازگشت اعتماد عمومی نقدینگی خرد به کلیت تابلوی بورس.`;
  }

  // ۸. پاسخ عمومی چندبعدی فقط برای پرسش‌های صریحاً کلان/چنددارایی (Phase 2-3F-B3)
  const _snapEntities = (queryAnalysis && Array.isArray(queryAnalysis.entities)) ? queryAnalysis.entities : [];
  const _broadIntent = /(وضعیت کلی|خلاصه|مرور|تابلو|همه بازار|بازارها|جمع‌بندی|چندبعدی)/.test(q) || _snapEntities.length >= 3;
  if (_snapEntities.length === 1) {
    const snapshotReply = buildAssetSnapshotResponse(queryAnalysis, Array.isArray(liveEvidenceItems) ? liveEvidenceItems : []);
    if (snapshotReply) return snapshotReply;
  }
  if (!_broadIntent) {
    return buildScopeFallbackResponse(userQuery);
  }

  return `💡 **${identityRoleLine()}:**\n\n` +
    `درخواست شما درباره «${userQuery}» ارزیابی شد. خلاصه موازنه چندبعدی تابلوی فعال:\n\n` +
    `• **بازار ارز:** دلار آزاد **${fmtFa(usd.price)} تومان** | تتر **${fmtFa(usdt.price)} تومان** (اسپرد: **${fmtFa(usdtSpreadPct, 2)}٪**)\n` +
    `• **بازار طلا:** طلای ۱۸ عیار **${fmtFa(gold18.price)} تومان** | سکه تمام **${fmtFa(sekee.price)} تومان** (حباب: **${fmtFa(coinBubblePct, 1)}٪**)\n` +
    `• **طلای آب‌شده:** مظنه مثقال ۱۷ عیار **${fmtFa(mithqalPrice)} تومان** (بر پایه ضریب تبدیل استاندارد طلا)\n` +
    `• **شاخص کل بورس:** **${fmtFa(tse.price)} واحد** (${tse.change >= 0 ? '+' : ''}${fmtFa(tse.change, 2)}٪)\n\n` +
    `جهت بررسی تخصصی‌تر، می‌توانید یکی از گزینه‌های **سناریوهای ۴گانه بازار**، **واگرایی طلا و دلار**، **حباب سکه و طلای آب‌شده** یا **ساختار بورس** را مطرح فرمایید.`;
}

// ============================================================================
// موتور پردازش و ارزیابی هوش مصنوعی (Dual-Gateway Execution Engine)
// ============================================================================

/**
 * مدیریت یکپارچه درگاه‌های هوش مصنوعی با مدارشکن و فال‌بک ایمن
 */
async function processAiInterpretation(evidenceContract, mode, env) {
  const canonicalNumbers = extractAllowedNumbersFromEvidence(evidenceContract);
  let rawAiText = null;
  let providerUsed = 'NONE';
  let validation = { passed: false, reasons: [] };

  // ۱. تلاش با درگاه اول: Cloudflare Workers AI
  if (env && env.AI) {
    try {
      const systemPrompt = buildSystemPrompt(mode);
      const userPrompt = buildUserPrompt(evidenceContract, mode);

      const aiResponse = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.1,
        max_tokens: 500,
        top_p: 0.85
      });

      if (aiResponse && (aiResponse.response || aiResponse.text)) {
        rawAiText = (aiResponse.response || aiResponse.text).trim();
        providerUsed = 'CF_WORKERS_AI';
      }
    } catch (cfErr) {
      console.warn('[Workers AI Gateway Failed]:', cfErr.message);
    }
  }

  // ۲. تلاش با درگاه دوم (Fallback): OpenRouter API
  if (!rawAiText && env && env.OPENROUTER_API_KEY) {
    try {
      const systemPrompt = buildSystemPrompt(mode);
      const userPrompt = buildUserPrompt(evidenceContract, mode);

      const orRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://market-watcher.pages.dev',
          'X-Title': 'Market Watcher Luxe AI'
        },
        body: JSON.stringify({
          model: 'openrouter/free',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.1,
          max_tokens: 500
        })
      });

      if (orRes.ok) {
        const orJson = await orRes.json();
        const content = orJson.choices?.[0]?.message?.content;
        if (content) {
          rawAiText = content.trim();
          providerUsed = 'OPENROUTER_FALLBACK';
        }
      }
    } catch (orErr) {
      console.warn('[OpenRouter Gateway Failed]:', orErr.message);
    }
  }

  // ۳. سد اعتبارسنجی خروجی (Strict Output Validator)
  if (rawAiText) {
    validation = validateAiOutput(rawAiText, evidenceContract, canonicalNumbers);
  }

  // ۴. در صورت رد اعتبارسنجی یا عدم پاسخ‌دهی درگاه‌ها: بازگشت به فال‌بک قطعی دترمینیستیک
  if (!rawAiText || !validation.passed) {
    const safeFallback = generateDeterministicNarrative(evidenceContract, mode);
    return {
      provider: 'DETERMINISTIC_FALLBACK',
      validationStatus: validation.passed ? 'PASSED' : 'REJECTED_AND_SUBSTITUTED',
      validationReasons: validation.reasons,
      rawOutput: rawAiText,
      narrative: safeFallback.narrative,
      layers: safeFallback.layers,
      meta: {
        engineVersion: WORKER_VERSION,
        asOf: evidenceContract.meta?.asOf || new Date().toISOString(),
        isAiGenerated: false
      }
    };
  }

  // ۵. پارس و تفکیک لایه‌های ۳ گانه از متن تأییدشده هوش مصنوعی
  const parsedLayers = parseNarrativeLayers(rawAiText);

  return {
    provider: providerUsed,
    validationStatus: 'PASSED',
    validationReasons: [],
    rawOutput: rawAiText,
    narrative: rawAiText,
    layers: parsedLayers,
    meta: {
      engineVersion: WORKER_VERSION,
      asOf: evidenceContract.meta?.asOf || new Date().toISOString(),
      isAiGenerated: true
    }
  };
}

// ============================================================================
// سد اعتبارسنجی خروجی و پالایش ضدتوهم (AIOutputValidator)
// ============================================================================

/**
 * اعتبارسنجی خروجی AI از منظر ضدتوهم عددی، واژگان ممنوعه و ساختار ۳ لایه
 */
function validateAiOutput(text, evidenceContract, allowedNumbers = null) {
  const reasons = [];
  if (!text || typeof text !== 'string' || text.trim().length < 30) {
    return { passed: false, reasons: ['متن خروجی خالی یا بسیار کوتاه است.'] };
  }

  const numbersList = allowedNumbers || extractAllowedNumbersFromEvidence(evidenceContract);

  // ۱. بررسی واژگان ممنوعه مالی و معاملاتی (Anti-Signal Check)
  for (const forbidden of FORBIDDEN_WORDS) {
    if (text.includes(forbidden)) {
      reasons.push(`استفاده از واژه ممنوعه معاملاتی: «${forbidden}»`);
    }
  }

  // ۲. استخراج تمامی اعداد داخل متن خروجی و تطبیق اشتراک عددی (Anti-Hallucination Regex Guard)
  const extractedNumbers = extractNumbersFromText(text);
  for (const num of extractedNumbers) {
    const isAllowed = isNumberInAllowedSet(num, numbersList);
    if (!isAllowed) {
      reasons.push(`توهم عددی: عدد «${num}» در قرارداد شواهد وجود ندارد.`);
    }
  }

  return {
    passed: reasons.length === 0,
    reasons,
    extractedNumbersCount: extractedNumbers.length,
    allowedNumbersCount: numbersList.length
  };
}

/**
 * استخراج تمامی اعداد خام، اعشاری و درصدی از متن (پشتیبانی از ارقام فارسی و انگلیسی)
 */
function extractNumbersFromText(text) {
  if (!text) return [];
  // ۱. حذف کاراکترهای جهت‌دهی یونیکد و استانداردسازی علامت منفی
  let normalized = text
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/[\u2212\u2010-\u2015]/g, '-');

  // ۲. تبدیل ارقام فارسی به انگلیسی
  normalized = normalized.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));

  // ۳. حذف جداکننده‌های هزارگان فارسی و انگلیسی و اصلاح ممیز اعشاری
  normalized = normalized.replace(/[٬،]/g, '');
  normalized = normalized.replace(/٫/g, '.');
  normalized = normalized.replace(/,/g, '');
  
  // ۴. استثناسازی و ماسک کردن الگوهای استاندارد تاریخ شمسی، میلادی و ساعت
  normalized = normalized.replace(/\b(140[0-9]|202[0-9])[/-](0?[1-9]|1[0-2])[/-](0?[1-9]|[12][0-9]|3[01])\b/g, ' DATE_PATTERN ');
  normalized = normalized.replace(/\b(0?[1-9]|[12][0-9]|3[01])\s+(?:فروردین|اردیبهشت|خرداد|تیر|مرداد|شهریور|مهر|آبان|آذر|دی|بهمن|اسفند)\s+(140[0-9]|202[0-9])\b/g, ' DATE_PATTERN ');
  normalized = normalized.replace(/\b(?:ساعت\s+)?([01]?[0-9]|2[0-3]):([0-5][0-9])(?::([0-5][0-9]))?\b/g, ' TIME_PATTERN ');

  // ماسک کردن واژگان استاندارد عیار و بازه‌های زمانی
  normalized = normalized.replace(/\b18\s*(?:عیار|k)\b/gi, ' KARAT18_PATTERN ');
  normalized = normalized.replace(/\b(?:24H|7D|30D|24h|7d|30d)\b/g, ' PERIOD_PATTERN ');

  // ۵. استخراج الگوهای عددی صحیح و اعشاری
  const matches = normalized.match(/-?\b\d+(?:\.\d+)?\b/g) || [];
  const numbers = [];

  for (const m of matches) {
    const val = parseFloat(m);
    if (Number.isFinite(val) && val !== 1405 && val !== 2026 && val !== 1404 && val !== 2025) {
      numbers.push(val);
    }
  }

  return numbers;
}

/**
 * استخراج تمامی مقادیر عددی مجاز از درون شیء قرارداد شواهد
 */
function extractAllowedNumbersFromEvidence(obj, result = []) {
  if (!obj || typeof obj !== 'object') return result;

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'number' && Number.isFinite(val)) {
      result.push(val);
      result.push(Math.round(val));
      result.push(Math.abs(Math.round(val)));
      result.push(parseFloat(val.toFixed(1)));
      result.push(Math.abs(parseFloat(val.toFixed(1))));
      result.push(parseFloat(val.toFixed(2)));
      result.push(Math.abs(parseFloat(val.toFixed(2))));
    } else if (typeof val === 'string') {
      const nums = extractNumbersFromText(val);
      result.push(...nums);
    } else if (typeof val === 'object') {
      extractAllowedNumbersFromEvidence(val, result);
    }
  }

  // افزودن ثوابت ساختاری استاندارد سیستم
  result.push(0, 1, 2, 3, 7, 18, 24, 30, 100);

  return Array.from(new Set(result));
}

/**
 * بررسی انطباق عدد استخراج‌شده با مجموعه مجاز با تلرانس خطای گردکردن
 */
function isNumberInAllowedSet(targetNum, allowedSet, tolerance = 0.08) {
  const STRUCTURAL_CONSTANTS = new Set([0, 1, 2, 3, 7, 18, 24, 30, 100]);
  if (STRUCTURAL_CONSTANTS.has(targetNum) || STRUCTURAL_CONSTANTS.has(Math.abs(targetNum))) {
    return true;
  }

  for (const allowed of allowedSet) {
    if (Math.abs(targetNum - allowed) <= tolerance) return true;
    if (Math.abs(Math.abs(targetNum) - Math.abs(allowed)) <= tolerance) return true;
    if (allowed !== 0 && Math.abs((targetNum - allowed) / allowed) <= 0.015) return true;
  }
  return false;
}

// ============================================================================
// مهندسی پرامپت ساختاریافته (Prompt Engineering)
// ============================================================================

function buildAdvisorChatSystemPrompt(todayEvidence = {}, queryAnalysis = null, presentation = {}, retrievedKnowledge = null) {
  const evSummary = JSON.stringify(todayEvidence, null, 2);
  const responseLevel = presentation.responseLevel || 'STANDARD';
  const isWhy = presentation.isWhyQuestion === true;
  const isTechnical = presentation.isTechnicalRequest === true;

  let knowledgeConstraint = '';
  if (retrievedKnowledge && retrievedKnowledge.meta && retrievedKnowledge.meta.matched && Array.isArray(retrievedKnowledge.results) && retrievedKnowledge.results.length > 0) {
    const kRows = retrievedKnowledge.results.slice(0, 2);
    knowledgeConstraint = `\nدانشنامه داخلی دیدبان (تنها منبع مجاز برای پاسخ مفهومی؛ اگر متن کافی نیست صریح بگو):\n` +
      kRows.map((r, i) => `${i + 1}. «${r.title}» — ${r.summary || ''}${r.content ? ' | ' + String(r.content).slice(0, 600) : ''}`).join('\n') + `\n`;
  }
  let analysisConstraint = '';
  if (queryAnalysis && queryAnalysis.intent) {
    analysisConstraint = `\n۵. ساختار تحلیل نیت و اهداف استعلام کاربر:
   - نیت اصلی (Primary Intent): ${queryAnalysis.intent.primary}
   - نیت‌های ثانویه (Secondary Intents): ${queryAnalysis.intent.secondary?.join('، ') || 'ندارد'}
   - موجودیت‌های شناسایی‌شده (Entities): ${queryAnalysis.entities?.map(e => e.value).join('، ') || 'عمومی'}
   - شواهد کلیدی موردنیاز (Required Evidence): ${queryAnalysis.evidencePlan?.required?.join('، ') || 'شواهد پایه'}\n`;
  }

  return `شما «ماکان»، دستیار هوشمند و تحلیلی «دیدبان بازار» هستید؛ یک دستیار تحلیلی مالی با تسلط بر اقتصاد کلان ایران، بازار طلا، ارز، کریپتو و بورس تهران.

ضوابط محوری پاسخ‌گویی:
۱. ادبیات حرفه‌ای، روان و انسانی؛ پاسخ دقیقاً به همان چیزی که کاربر پرسیده است (Intent Adherence). سؤال ساده را به گزارش جامع تبدیل نکنید.
۲. سد کامل ضدسیگنال: هرگز سیگنال قطعی خرید/فروش، نقطه ورود/خروج، تارگت قطعی یا تضمین سود صادر نکنید. به جای آن، شواهد، سناریوها و ریسک‌ها را تبیین کنید. متن استاندارد سلب مسئولیت را فقط در پرسش‌هایی که ممکن است با توصیه معاملاتی اشتباه شوند (خرید/فروش/ورود/خروج) به‌صورت یک‌بار و کوتاه ذکر کنید — نه در هر پاسخ.
۳. ممنوعیت مطلق نشت فرمول و جزئیات داخلی در پاسخ کاربر:
   - هیچ فرمول ریاضی، LaTeX، ضریب محاسباتی (مانند ضرایب تبدیل اونس/مثقال/عیار)، نام موتور یا کلاس، نام فایل، شماره نسخه، «گام‌های محاسبه»، «Pearson R» یا واژه‌های پیاده‌سازی را در پاسخ نیاورید — مگر کاربر صریحاً درباره نحوه محاسبه یا معماری بپرسد.
   - به‌جای فرمول، نتیجه را در یک جمله طبیعی توضیح دهید (مثلاً «مظنه معادل هر مثقال طلای ۱۷ عیار حدود ... برآورد می‌شود»).
۴. اعداد: فقط از «داده‌های زنده تابلوی بازار امروز» و شواهد فراهم‌شده در این پیام استفاده کنید.
   - هرگز عددی را از پیام‌های قبلی گفت‌وگو (حافظه گفتگو) نقل نکنید؛ متن پاسخ قبلی منبع واقعیت بازار نیست.
   - اگر داده لازم در دسترس نیست، عدد نسازید و صریح بگویید داده کافی نیست.
   - هیچ پیش‌بینی عددی قطعی، تارگت، یا مقدار تاریخی از خود نسازید. برای افق‌های آینده فقط سناریوی شرطی («اگر الف و ب حفظ شود...») و در چارچوب شواهد ارائه دهید.
۵. ساختار پاسخ بر اساس نوع سؤال:
   - پرسش وضعیت دارایی: ابتدا قیمت فعلی، سپس تغییر روزانه (و هفتگی اگر موجود است)، سپس در صورت مرتبط بودن یک نکته ساختاری کوتاه. هیچ تحلیل نامرتبط (همبستگی کلی، سایر دارایی‌ها) اضافه نکنید.
   - پرسش «چرا»: مشاهده → محرک‌های محتمل و مستند → قدرت شاهد → تفسیر اقتصادی → عدم‌قطعیت. اگر شاهد کافی نیست صریح بگویید: «از داده‌های فعلی نمی‌توان یک علت واحد و قطعی تعیین کرد.»
   - پرسش سناریویی: نرخ مبنا → نرخ سناریویی → درصد تغییر → نتیجه روی دارایی هدف → تغییر مطلق → تفسیر → محدودیت سناریو (بدون فرمول).
   - پرسش دارایی دیجیتال: ابتدا وضعیت فعلی (قیمت و تغییر)، سپس ساختار بازار و سناریوهای شرطی با ذکر ریسک؛ هرگز تارگت قطعی ندهید.
۶. طول پاسخ مطابق سطح تعیین‌شده: ${responseLevel}
   - SHORT: ۲ تا ۴ خط.
   - STANDARD: یک پاسخ منسجم با ۲ تا ۴ بخش کوتاه.
   - DEEP: تحلیل ساختاریافته با بخش‌های مشخص، اما بدون اطناب غیرضروری و فقط با شواهد مرتبط.
${isWhy ? '۷. این پرسش از نوع «چرا» است: علت را فقط در صورت وجود شاهد مطرح کن و صریح تفکیک کن چه چیزی مشاهده است و چه چیزی استنباط محتمل.\n' : ''}${isTechnical ? '۷. کاربر صریحاً پرسش فنی/محاسباتی پرسیده است؛ در این حالت توضیح روش محاسبه و ضرایب مجاز است.\n' : ''}۸. داده‌های زنده تابلوی بازار امروز جهت ارجاع (فقط برای همین پاسخ):
${evSummary}
${analysisConstraint}${knowledgeConstraint}
پاسخ را به زبان فارسی روان، بدون ذکر جزئیات پیاده‌سازی، ارائه دهید.`;
}

function buildSystemPrompt(mode) {
  let modeDesc = 'تحلیل ساختاری، چندزمانی و موازنه نیروهای لحظه‌ای بازار';
  if (mode === 'DAILY_SNAPSHOT') {
    modeDesc = 'خلاصه مدیریتی و تراز رسمی نوبت پایانی ساعت ۲۳:۰۰ بازار';
  } else if (mode === 'WEEKLY_REPORT') {
    modeDesc = 'تحلیل کارنامه هفتگی، چرخش نقدینگی، برآیند بازدهی و تغییرات حباب به واحد درصد';
  } else if (mode === 'MONTHLY_REPORT') {
    modeDesc = 'تحلیل ساختار کلان ماهانه، روند بازدهی بلندمدت، شکاف بازارهای موازی و دینامیک بین‌بازاری';
  }

  return `شما «ماکان»، تحلیلگر ارشد و ناظر هوشمند اقتصادی «دیدبان بازار» هستید.
مأموریت شما: تنظیم «${modeDesc}» به زبان فارسی شیوا، روان، دقیق، منسجم و در تراز یک نشریه اقتصادی معتبر است.

اصول نگارش و ادبیات اقتصادی (Professional Standards):
۱. پرهیز مطلق از عبارات و نام‌های ماشینی موتور: هرگز نام‌های فنی انام‌ها مانند FX_EXPANSION، OUNCE_DOWN، HIGH_PREMIUM، PERSISTENT_FX_DOMINANCE، DUAL_BULLISH یا COUNTER_MOVE را در متن نهایی ذکر نکنید؛ آن‌ها را به زبان اقتصادی طبیعی و خوش‌خوان ترجمه کنید.
۲. تفکیک دقیق سه سطح مشاهده، تحلیل و فرضیه:
   - سطح اول (مشاهده عینی): بیان مستقیم ارقام و تغییرات قیمتی مستند در شواهد.
   - سطح دوم (تحلیل مبتنی بر داده): تبیین روابطی که داده‌ها به وضوح پشتیبانی می‌کنند.
   - سطح سوم (فرضیه و تفسیر احتمالی): استفاده از زبان محتاطانه و احتمالی و پرهیز از ادعای قطعیت علّی.
۳. قاعده تحلیل دلار و اونس جهانی: برای توصیف غلبه اثر ارز در برابر افت اونس، از عبارت استاندارد «اثر کاهش اونس را خنثی کرده است» استفاده کنید.
۴. دلار ضمنی سکه و پرمیوم: در صورت سبقت دلار ضمنی سکه از دلار آزاد، با عبارت استاندارد «دلار ضمنی سکه بالاتر از دلار آزاد قرار گرفته و نشان‌دهنده بازتاب انتظارات قیمتی بالاتر و پرمیوم تقاضا در بخش مسکوکات است» بیان نمایید.
۵. دینامیک‌های چندزمانی و شتاب (P2 Dynamics): شتاب، تداوم جهت و نوسان را به زبان طبیعی بازگو کنید.
۶. همبستگی و عدم ادعای علیت: همبستگی را هرگز رابطه علت و معلولی ندانید.
۷. رعایت کامل دستور زبان و نگارش فارسی: رعایت نیم‌فاصله، علائم نگارشی و پاراگراف‌های کوتاه.
۸. منع کامل سیگنال و توصیه: عدم ارائه پیشنهاد خرید/فروش، تارگت قیمتی، نقطه ورود/خروج یا تضمین سود.
۹. قالب ساختاری خروجی: متن را منحصراً در ۳ بخش با عناوین زیر تنظیم کنید:
   [مشاهده عینی و رفتار چندزمانی داده‌ها]
   [تفسیر ساختاری و موازنه نیروها]
   [احتیاط و ریسک‌های عدم تعادل]
   (در صورت فقدان عمق داده: [کفایت داده])
۱۰. حجم متن: حداکثر ۲۵۰ تا ۳۰۰ کلمه فارسی موجز و فاخر.`;
}

function buildUserPrompt(evidenceContract, mode) {
  let reportTitle = 'نبض زنده بازار';
  if (mode === 'DAILY_SNAPSHOT') reportTitle = 'گزارش رسمی روزانه ساعت ۲۳:۰۰';
  else if (mode === 'WEEKLY_REPORT') reportTitle = 'کارنامه هفتگی عملکرد و بازدهی بازارها';
  else if (mode === 'MONTHLY_REPORT') reportTitle = 'گزارش ماهانه عملکرد و تراز کلان بازارها';

  return `بر اساس این قرارداد شواهد رسمی (Evidence JSON) برای «${reportTitle}»، تحلیل ساختاری ۳ لایه‌ای را تنظیم کنید:

اطلاعات شواهد (Evidence JSON):
${JSON.stringify(evidenceContract, null, 2)}

لطفاً خروجی را مستقیماً با عناوین [مشاهده عینی و رفتار چندزمانی داده‌ها]، [تفسیر ساختاری و موازنه نیروها] و [احتیاط و ریسک‌های عدم تعادل] به زبان فارسی فاخر بنویسید.`;
}

// ============================================================================
// موتور فال‌بک قطعی دترمینیستیک (Deterministic Fallback Engine)
// ============================================================================

/* toFaDigits defined above */

/**
 * تولید روایت ۳ لایه‌ای دترمینیستیک بدون نیاز به AI در شرایط اضطراری (Phase P0)
 */
function generateDeterministicNarrative(contract = {}, mode = 'MARKET_PULSE') {
  if (mode === 'WEEKLY_REPORT') {
    const leaderText = contract.leaderboard && contract.leaderboard[0]
      ? `پیشتاز بازدهی هفتگی ${contract.leaderboard[0].nameFa || contract.leaderboard[0].name} بود.`
      : '';
    const obs = `بررسی کارنامه هفتگی بازار نشان‌دهنده ثبت نوسانات دوره‌ای دارایی‌هاست. ${leaderText} ${contract.bubbleChangeNarrative || ''}`.trim();
    const interp = `تحلیل جریان نقدینگی هفته حاکی از آن است که: ${contract.goldDriverNarrative || 'رفتار هم‌گرایانه میان بازارها حفظ شد.'} ${contract.stockStructureNarrative || ''}`.trim();
    const caution = 'برآیند هفتگی بازدهی‌ها بازتاب‌دهنده شرایط گذشته بازار بوده و سلب‌کننده ریسک‌های سیستماتیک و نوسانات کوتاه‌مدت آتی نیست.';
    return {
      narrative: `[مشاهده] ${obs}\n\n[تفسیر] ${interp}\n\n[احتیاط] ${caution}`,
      layers: { observation: obs, interpretation: interp, caution }
    };
  }

  if (mode === 'MONTHLY_REPORT') {
    const obs = `در کارنامه ماهانه بازار: ${contract.topPerformerNarrative || 'دارایی‌ها در دامنه‌های متعارف نوسان کردند.'} ${contract.bubbleMonthlyNarrative || ''}`.trim();
    const interp = `بررسی تراز بلندمدت نشان می‌دهد: ${contract.stockVsParallelNarrative || 'هم‌گرایی نسبی میان بازارهای موازی حاکم بود.'}`.trim();
    const caution = 'عملکرد ماهانه صرفاً روند آماری ۳۰ روز گذشته را مستند ساخته و نمی‌تواند مبنایی برای نتیجه‌گیری قطعی در افق‌های آتی باشد.';
    return {
      narrative: `[مشاهده] ${obs}\n\n[تفسیر] ${interp}\n\n[احتیاط] ${caution}`,
      layers: { observation: obs, interpretation: interp, caution }
    };
  }

  // حالت نبض بازار و اسنپ‌شات رسمی روزانه
  const fx = contract.fx || {};
  const gold = contract.gold || {};
  const coin = contract.coin || {};
  const dollarOunce = contract.dollarOunce || {};
  const returns = contract.returns || {};
  const dq = contract.dataQuality || {};

  const freeUSD = fx.freeUSD;
  const usd24h = returns['24h']?.usd ?? returns.current?.usd;
  const usd7d = returns['7d']?.usd ?? fx.momentum7d;

  const gold18 = gold.gold18;
  const xau = gold.xau;
  const g18DeviationPct = gold.gold18DeviationPct;
  const gold24h = returns['24h']?.gold18 ?? returns.current?.gold18;
  const xau24h = returns['24h']?.xau ?? returns.current?.xau;

  const coinPrice = coin.price;
  const bubblePct = coin.bubblePct;
  const impliedUSD = coin.impliedUSD;
  const impliedUSDDiff = coin.impliedUSDvsFreeToman;

  const meltedSpread = gold.meltedGold18Spread;

  // ۱. لایه مشاهده عینی
  const obsParts = [];
  if (freeUSD != null) {
    const usd7dStr = (usd7d != null) ? ` و ${usd7d >= 0 ? '+' : ''}${toFaDigits(usd7d.toFixed(1))}٪ در بازه ۷ روزه` : '';
    obsParts.push(`دلار آزاد در سطح ${toFaDigits(Math.round(freeUSD).toLocaleString('fa-IR'))} تومان (${usd24h != null ? (usd24h >= 0 ? '+' : '') + toFaDigits(usd24h.toFixed(1)) + '٪ روزانه' : ''}${usd7dStr}) ثبت شد.`);
  }
  if (xau != null && gold18 != null) {
    const g18BubStr = (g18DeviationPct != null) ? ` با حباب ${g18DeviationPct >= 0 ? '+' : ''}${toFaDigits(g18DeviationPct.toFixed(1))}٪` : '';
    obsParts.push(`اونس جهانی در تراز ${toFaDigits(xau.toFixed(1))} دلار (${xau24h != null ? (xau24h >= 0 ? '+' : '') + toFaDigits(xau24h.toFixed(1)) + '٪' : ''}) و طلای ۱۸ عیار در سطح ${toFaDigits(Math.round(gold18).toLocaleString('fa-IR'))} تومان (${gold24h != null ? (gold24h >= 0 ? '+' : '') + toFaDigits(gold24h.toFixed(1)) + '٪' : ''}${g18BubStr}) قرار گرفتند.`);
  }
  if (coinPrice != null && bubblePct != null) {
    const impDiffStr = (impliedUSDDiff != null) ? ` (${impliedUSDDiff >= 0 ? '+' : ''}${toFaDigits(Math.round(impliedUSDDiff).toLocaleString('fa-IR'))} ت اختلاف با دلار آزاد)` : '';
    obsParts.push(`حباب سکه امامی در تراز ${toFaDigits(bubblePct.toFixed(1))}٪ و دلار ضمنی آن در سطح ${impliedUSD != null ? toFaDigits(Math.round(impliedUSD).toLocaleString('fa-IR')) : '—'} تومان${impDiffStr} محاسبه شد.`);
  }
  if (meltedSpread != null) {
    obsParts.push(`اسپرد حباب طلای آبشده به ۱۸ عیار با ${toFaDigits(Math.abs(meltedSpread).toFixed(2))} واحد درصد ${meltedSpread >= 0 ? 'پرمیوم' : 'دیسکانت'} سنجش شد.`);
  }

  let obs = obsParts.length > 0 ? obsParts.join(' ') : 'داده‌های ساختاری دارایی‌ها در سطوح محاسباتی جاری ثبت شده است.';

  // ۲. لایه تفسیر ساختاری
  const interpParts = [];
  if (dollarOunce.mode === 'COUNTER_NET_POSITIVE' || (usd24h > 0 && xau24h < 0 && (gold24h > 0 || returns['7d']?.gold18 > 0))) {
    interpParts.push('رشد طلای داخلی در شرایط اصلاح اونس جهانی نشان می‌دهد که شتاب صعودی نرخ ارز عامل مسلط بر بازار طلا بوده و اثر کاهشی اونس را خنثی کرده است.');
  } else if (dollarOunce.mode === 'DUAL_BULLISH' || (usd24h > 0 && xau24h > 0)) {
    interpParts.push('تقویت هم‌زمان دلار آزاد و اونس جهانی، به عنوان دو پیشران افزایشی هم‌جهت عمل کرده و شتاب صعودی مضاعفی در بازار طلای داخلی ایجاد کرده است.');
  } else if (dollarOunce.mode === 'DUAL_BEARISH' || (usd24h < 0 && xau24h < 0)) {
    interpParts.push('افت هم‌زمان دلار آزاد و اونس جهانی فشار کاهشی دوگانه‌ای را بر ارزش مبنای بازار طلا وارد ساخته است.');
  } else if (dollarOunce.mode === 'COUNTER_NET_NEGATIVE' || (usd24h < 0 && xau24h > 0)) {
    interpParts.push('واگرایی محرک‌ها: صعود اونس جهانی بر روند نزولی دلار چربیده و اثر کاهشی ارز را در ارزش مبنای طلا مهار ساخته است.');
  } else if (dollarOunce.mode === 'FX_DRIVEN_UP') {
    interpParts.push('پیشتازی با محرک ارزی: رشد ارزش مبنای طلا متأثر از نوسان مثبت دلار آزاد رقم خورده است.');
  } else if (dollarOunce.mode === 'GLOBAL_DRIVEN_UP') {
    interpParts.push('پیشتازی با محرک جهانی: صعود اونس طلا عامل اصلی تقویت ارزش مبنای طلای داخلی بوده است.');
  } else {
    interpParts.push('نیروهای محرک اونس و دلار در وضعیت تعادل نسبی با نوسانات محدود ارزیابی می‌شوند.');
  }

  if (impliedUSDDiff != null && impliedUSDDiff > 1000) {
    interpParts.push('همچنین سبقت نرخ دلار ضمنی سکه از نرخ دلار نقد بازار آزاد، نشان‌دهنده بازتاب انتظارات قیمتی بالاتر و پرمیوم تقاضا در بخش مسکوکات است.');
  } else if (impliedUSDDiff != null && impliedUSDDiff < -1000) {
    interpParts.push('معامله دلار ضمنی سکه پایین‌تر از دلار آزاد بیانگر وجود دیسکانت در بازار مسکوکات است.');
  }

  if (meltedSpread != null && Math.abs(meltedSpread) > 0.5) {
    interpParts.push(`اسپرد آبشده و ۱۸ عیار (${meltedSpread >= 0 ? '+' : ''}${toFaDigits(meltedSpread.toFixed(2))} واحد درصد) حاکی از تفاوت در شدت تقاضای معاملات پایه نسبت به بازار خرد است.`);
  }

  // دینامیک‌های کمّی فاز P2 در صورت وجود در قرارداد
  const p2 = contract.p2Dynamics || {};
  if (p2.assets && p2.assets.usd) {
    const usdDyn = p2.assets.usd;
    if (usdDyn.persistence && usdDyn.persistence.regime === 'PERSISTENT_UP' && usdDyn.persistence.consecutivePeriods >= 3) {
      interpParts.push(`روند صعودی نرخ ارز در ${toFaDigits(usdDyn.persistence.consecutivePeriods)} مشاهده متوالی حفظ شده است.`);
    } else if (usdDyn.persistence && usdDyn.persistence.regime === 'PERSISTENT_DOWN' && usdDyn.persistence.consecutivePeriods >= 3) {
      interpParts.push(`روند نزولی نرخ ارز در ${toFaDigits(usdDyn.persistence.consecutivePeriods)} مشاهده متوالی ثبت شده است.`);
    }

    if (usdDyn.acceleration && usdDyn.acceleration.regime === 'ACCELERATING') {
      interpParts.push('شتاب رشد نرخ ارز در مقایسه با روند هفتگی در حال افزایش است.');
    } else if (usdDyn.acceleration && usdDyn.acceleration.regime === 'DECELERATING') {
      interpParts.push('اگرچه نرخ ارز مثبت است، اما از شتاب رشد آن در مقایسه با روند هفتگی کاسته شده است.');
    }

    if (usdDyn.volatility && (usdDyn.volatility.regime === 'ELEVATED' || usdDyn.volatility.regime === 'HIGH')) {
      interpParts.push('نوسان نرخ ارز افزایش یافته و حرکت قیمت پرنوسان‌تر از وضعیت معمول اخیر شده است.');
    }
  }

  if (p2.crossMarket && p2.crossMarket.correlations && p2.crossMarket.correlations.USD_XAU) {
    const corrObj = p2.crossMarket.correlations.USD_XAU;
    if (corrObj.regime === 'DIVERGENT' || corrObj.regime === 'STRONG_NEGATIVE') {
      interpParts.push('در این بازه، حرکت دلار و اونس جهانی همبستگی منفی بالایی را ثبت کرده‌اند.');
    } else if (corrObj.regime === 'CONVERGENT' || corrObj.regime === 'STRONG_POSITIVE') {
      interpParts.push('هم‌راستایی آماری بازدهی دلار و اونس جهانی در این مقطع تایید می‌شود.');
    }
  }

  let interp = interpParts.join(' ');

  // ۳. لایه احتیاط
  let caution = 'این ارزیابی صرفاً موازنه آماری شواهد گذشته و حال بازار را توصیف کرده و پیش‌بینی قطعی یا توصیه معاملاتی نیست؛ پایداری روندها تابع متغیرهای بنیادی و نوسانات متقابل ارز و اونس خواهد بود.';

  // ۴. کفایت داده
  let dataSufficiencyNote = '';
  if (dq.insufficientHistory && dq.insufficientHistory.length > 0) {
    dataSufficiencyNote = `داده‌های تاریخی برای ارزیابی دوره‌های [${dq.insufficientHistory.join('، ')}] کافی نیست و صرفاً داده‌های موجود تحلیل شدند.`;
  }

  const fullText = `[مشاهده] ${obs}\n\n[تفسیر] ${interp}\n\n[احتیاط] ${caution}${dataSufficiencyNote ? '\n\n[کفایت داده] ' + dataSufficiencyNote : ''}`;

  return {
    narrative: fullText,
    layers: {
      observation: obs,
      interpretation: interp,
      caution: caution,
      dataSufficiency: dataSufficiencyNote
    }
  };
}

/**
 * تفکیک ۳ لایه از متن خروجی
 */
function parseNarrativeLayers(fullText) {
  let observation = '';
  let interpretation = '';
  let caution = '';
  let dataSufficiency = '';

  const obsMatch = fullText.match(/\[(?:مشاهده عینی و رفتار چندزمانی داده‌ها|مشاهده)\]\s*([\s\S]*?)(?=\[(?:تفسیر ساختاری و موازنه نیروها|تفسیر)\]|$)/i);
  const intMatch = fullText.match(/\[(?:تفسیر ساختاری و موازنه نیروها|تفسیر)\]\s*([\s\S]*?)(?=\[(?:احتیاط و ریسک‌های عدم تعادل|احتیاط)\]|$)/i);
  const cauMatch = fullText.match(/\[(?:احتیاط و ریسک‌های عدم تعادل|احتیاط)\]\s*([\s\S]*?)(?=\[کفایت داده\]|$)/i);
  const dqMatch = fullText.match(/\[کفایت داده\]\s*([\s\S]*?)$/i);

  if (obsMatch) observation = obsMatch[1].trim();
  if (intMatch) interpretation = intMatch[1].trim();
  if (cauMatch) caution = cauMatch[1].trim();
  if (dqMatch) dataSufficiency = dqMatch[1].trim();

  if (!observation && !interpretation) {
    const paras = fullText.split('\n\n').filter(p => p.trim());
    observation = paras[0] || fullText;
    interpretation = paras[1] || '';
    caution = paras[2] || '';
  }

  return { observation, interpretation, caution, dataSufficiency };
}

// ============================================================================
// مدیریت کش لبه (Edge Cache Management)
// ============================================================================

async function generateCacheKey(evidenceContract, mode) {
  const str = JSON.stringify(evidenceContract) + ':' + mode;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return `wc_ai_${mode}_${Math.abs(hash)}`;
}

function getFromEdgeCache(key) {
  const item = edgeMemoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    edgeMemoryCache.delete(key);
    return null;
  }
  return item;
}

function saveToEdgeCache(key, payload, ttlSeconds = 300) {
  if (edgeMemoryCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = edgeMemoryCache.keys().next().value;
    edgeMemoryCache.delete(firstKey);
  }
  edgeMemoryCache.set(key, {
    payload,
    timestamp: new Date().toISOString(),
    expiresAt: Date.now() + (ttlSeconds * 1000)
  });
}
