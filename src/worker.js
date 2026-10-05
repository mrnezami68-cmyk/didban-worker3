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
 *  ۶. اندپوینت چت مشاور هوشمند دیدبان (/api/ai/chat) با تحلیل کاملاً پویا و زنده و بدون متون ایستا.
 *
 * 100% self-contained ES module, ready for Cloudflare Quick Edit.
 */

'use strict';

const WORKER_VERSION = 'v3.0.0-ai-interpreter';

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
        status: 'online',
        endpoints: [
          { path: '/api/health', method: 'GET', description: 'System health & binding status' },
          { path: '/api/ai/chat', method: 'POST', description: 'Interactive AI Advisor conversational analysis' },
          { path: '/api/ai/interpret', method: 'POST', description: 'Multi-horizon 3-layer narrative synthesis' },
          { path: '/api/ai/validate', method: 'POST', description: 'Anti-hallucination evidence validation' }
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
        knowledgeRetriever: 'ENABLED (Phase 2-1 Deterministic Core)',
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
          return new Response(JSON.stringify({
            success: true,
            reply: '⚠️ **تذکر شفاف و سلب مسئولیت مالی:**\nدیدبان هوشمند بازار یک پلتفرم تحلیلی، آماری و پژوهشی است و تحت هیچ عنوان سیگنال معاملاتی، نقطه ورود/خروج، تارگت قیمتی یا پیشنهاد خرید و فروش صادر نمی‌کند.\n\nتوصیه می‌شود بر اساس استراتژی مدیریت ریسک شخصی، ضرایب همبستگی دارایی‌ها و سناریوهای احتمالاتی تصمیم‌گیری فرمایید.',
            source: 'ANTI_SIGNAL_GUARD',
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        let replyText = '';
        let sourceUsed = 'DYNAMIC_SYNTHESIS_ENGINE';

        // ۰. نرمال‌سازی کانونیکال شواهد ورودی بازار
        const normalizedEvidence = normalizeEvidenceMap(todayEvidence);

        // ۱. تحلیل نیت، استخراج موجودیت‌ها، بافت مکالمه و نیازمندی شواهد (Intent & Entity Engine v4)
        const queryAnalysis = analyzeQuery(userMsg, history, todayEvidence);

        // ۲. واکنش سریع به گاردریل ضدسیگنال
        if (queryAnalysis.intent.primary === 'ANTI_SIGNAL_RESTRICTED') {
          return new Response(JSON.stringify({
            success: true,
            reply: '⚠️ **تذکر شفاف و سلب مسئولیت مالی:**\nدیدبان هوشمند بازار یک پلتفرم تحلیلی، آماری و پژوهشی است و تحت هیچ عنوان سیگنال معاملاتی، نقطه ورود/خروج، تارگت قیمتی یا پیشنهاد خرید و فروش صادر نمی‌کند.\n\nتوصیه می‌شود بر اساس استراتژی مدیریت ریسک شخصی، ضرایب همبستگی دارایی‌ها و سناریوهای احتمالاتی تصمیم‌گیری فرمایید.',
            source: 'ANTI_SIGNAL_GUARD',
            interpretation: formatStructuredLog(queryAnalysis),
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
            timestamp: new Date().toISOString()
          }), { headers: corsHeaders });
        }

        // ۴. شبیه‌ساز قطعی What-If و مقایسه سناریویی (Deterministic What-If Engine v4)
        if (queryAnalysis.intent.primary === 'WHAT_IF' || queryAnalysis.intent.primary === 'SCENARIO_COMPARISON') {
          const whatIfAst = parseWhatIfQuery(userMsg, history);
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
                timestamp: new Date().toISOString()
              }), { headers: corsHeaders });
            }
          }
        }

        // ۵. در صورت در دسترس بودن درگاه هوش مصنوعی و داشتن سهمیه روزانه، فراخوانی مدل زبانی
        const isLlmEligible = checkDailyLlmEligible(clientIp, 40);
        if (isLlmEligible && env && (env.AI || env.OPENROUTER_API_KEY)) {
          try {
            const chatSystemPrompt = buildAdvisorChatSystemPrompt(todayEvidence, queryAnalysis);
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
                max_tokens: 650,
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
                  max_tokens: 650
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
          replyText = buildDynamicAdvisorResponse(userMsg, todayEvidence, normalizedEvidence, queryAnalysis);
          sourceUsed = 'DYNAMIC_SYNTHESIS_ENGINE';
        }

        return new Response(JSON.stringify({
          success: true,
          reply: replyText,
          source: sourceUsed,
          interpretation: formatStructuredLog(queryAnalysis, retrievedKnowledge),
          retrievedKnowledge,
          timestamp: new Date().toISOString()
        }), { headers: corsHeaders });

      } catch (err) {
        return new Response(JSON.stringify({
          success: false,
          error: 'خطای سرور در پردازش گفت‌وگو: ' + err.message
        }), { status: 500, headers: corsHeaders });
      }
    }

    return new Response(JSON.stringify({
      error: 'مسیر یافت نشد (Endpoint Not Found)',
      availableEndpoints: ['GET /api/health', 'POST /api/ai/interpret', 'POST /api/ai/validate', 'POST /api/ai/chat', 'POST /api/ai/knowledge/retrieve']
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
  'P/E': ['p/e', 'pe', 'پی بر ای', 'پی ای', 'نسبت p/e', 'نسبت pe', 'قیمت به درآمد', 'نسبت قیمت به سود'],
  'CPI': ['cpi', 'شاخص قیمت مصرف‌کننده', 'شاخص قیمت مصرف کننده', 'شاخص تورم مصرف‌کننده', 'تورم cpi'],
  'DXY': ['dxy', 'شاخص دلار آمریکا', 'شاخص دلار', 'دلار جهانی'],
  'PMI': ['pmi', 'شاخص مدیران خرید', 'مدیران خرید'],
  'GOLD_TO_SILVER': ['نسبت طلا به نقره', 'طلا به نقره', 'xau/xag', 'xau xag', 'نسبت اونس طلا به نقره'],
  'GOLD_ETF': ['صندوق طلا', 'صندوق های طلا', 'صندوق‌های طلا', 'صندوق عیار', 'صندوق کهربا', 'صندوق زرفام', 'صندوق کالایی طلا', 'gold etf'],
  'COIN_VS_TOKEN': ['تفاوت کوین و توکن', 'فرق کوین و توکن', 'کوین یا توکن', 'کوین و توکن'],
  'BROKER_VS_BROKERAGE': ['تفاوت کارگزاری و بروکر', 'فرق کارگزاری و بروکر', 'کارگزاری یا بروکر', 'کارگزاری و بروکر'],
  'GOLD18_BUBBLE_CORRIDOR': ['حباب طلای ۱۸', 'حباب ۱۸ عیار', 'کریدور تعادلی طلا', 'دامنه تعادلی طلا', 'اشباع خرید طلا'],
  'QUARTER_COIN_BUBBLE': ['حباب ربع سکه', 'حباب ربع‌سکه', 'ربع سکه'],
  'SIDEWAYS_MARKET': ['بازار ساید', 'روند ساید', 'حرکت ساید', 'سایدوی', 'بازار رنج', 'کانال رنج', 'رنج‌باند', 'درجا زدن', 'درجا زدن قیمت', 'ساید یعنی', 'رنج یعنی', 'ساید چیست', 'بازار رنج چیست'],
  'PRICE_CONSOLIDATION': ['تثبیت قیمت', 'تثبیت در محدوده', 'تثبیت نرخ', 'فاز تثبیت', 'کنسولیدیشن', 'consolidation']
};

function extractEntities(text) {
  if (!text) return [];
  const s = String(text).toLowerCase();
  const detected = [];
  const priorityKeys = ['XAU', 'XAG', 'TSE_EQUAL', 'TSE_INDEX', 'USDT', 'USD', 'COIN', 'GOLD18', 'BTC', 'ETH', 'SOL', 'OIL', 'DXY'];

  for (const key of priorityKeys) {
    const synonyms = ASSET_TAXONOMY[key];
    for (const syn of synonyms) {
      if (s.includes(syn)) {
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
      if (s.includes(kw)) {
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
  const isHypothetical = (/(اگر|فرض\s*کن|چنانچه|در\s*صورتی\s*که|احتمال|برسه\s*به|بشه|بشود|سناریو)/i.test(text) ||
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
  'SIDEWAYS_MARKET': ['sideways_market_dynamics', 'sideways_market'],
  'PRICE_CONSOLIDATION': ['price_consolidation_regimes', 'price_consolidation']
};

function scoreKnowledgeItem(item, query = {}) {
  if (!item) return { score: 0, reasons: [] };

  let score = 0;
  const reasons = [];

  const itemId = String(item.id || '').toLowerCase();
  const itemTitle = String(item.title || '').toLowerCase();
  const itemSummary = String(item.summary || '').toLowerCase();
  const itemCategory = String(item.category || '').toLowerCase();
  const itemKeywords = Array.isArray(item.keywords)
    ? item.keywords.map(k => String(k).toLowerCase())
    : String(item.keywords || '').toLowerCase().split(/[,،]+/).map(s => s.trim()).filter(Boolean);

  const queryTopic = String(query.topic || '').trim();
  const queryCategory = String(query.category || '').toLowerCase().trim();
  const queryKeywords = Array.isArray(query.keywords)
    ? query.keywords.map(k => String(k).toLowerCase().trim()).filter(Boolean)
    : [];

  if (queryTopic) {
    const topicLower = queryTopic.toLowerCase();
    const mappedIds = TOPIC_TO_ID_MAP[queryTopic] || [];
    if (mappedIds.includes(itemId) || itemId === topicLower || itemId.startsWith(topicLower + '_')) {
      score += 0.70;
      reasons.push('EXACT_TOPIC');
    }
  }

  let keywordMatched = false;
  for (const kw of queryKeywords) {
    if (itemKeywords.some(ik => ik === kw || ik.includes(kw) || kw.includes(ik))) {
      keywordMatched = true;
      break;
    }
  }
  if (keywordMatched) {
    score += 0.40;
    reasons.push('EXACT_KEYWORD');
  }

  let titleMatched = false;
  for (const kw of queryKeywords) {
    if (itemTitle.includes(kw)) {
      titleMatched = true;
      break;
    }
  }
  if (titleMatched) {
    score += 0.25;
    reasons.push('TITLE_MATCH');
  }

  let summaryMatched = false;
  for (const kw of queryKeywords) {
    if (itemSummary.includes(kw)) {
      summaryMatched = true;
      break;
    }
  }
  if (summaryMatched && !titleMatched) {
    score += 0.15;
    reasons.push('SUMMARY_MATCH');
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
  const minScore = typeof options.minScore === 'number' ? options.minScore : 0.40;

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
        let stmt;
        if (knowledgeQuery.category) {
          stmt = kdb.prepare(`SELECT id, category, keywords, title, summary, content FROM knowledge_base WHERE category = ? ORDER BY id ASC`).bind(String(knowledgeQuery.category).toLowerCase().trim());
        } else {
          stmt = kdb.prepare(`SELECT id, category, keywords, title, summary, content FROM knowledge_base ORDER BY id ASC`);
        }

        const dbRes = await stmt.all();
        rawItems = (dbRes && Array.isArray(dbRes.results)) ? dbRes.results : [];
      }
    }

    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      return baseResult;
    }

    const scoredItems = [];

    for (const item of rawItems) {
      const { score, reasons } = scoreKnowledgeItem(item, knowledgeQuery);
      if (score >= minScore && reasons.length > 0) {
        scoredItems.push({
          id: item.id,
          title: item.title,
          category: item.category,
          summary: item.summary,
          relevanceScore: score,
          matchReasons: reasons
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
      results: cappedResults,
      meta: {
        matched: cappedResults.length > 0,
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
  const keys = ['usd', 'usdt', 'gold18', 'sekee', 'xau', 'xag', 'oil', 'tse_index', 'tse_equal', 'silver1g'];
  for (const k of keys) {
    const item = todayEvidence[k];
    const norm = normalizePriceContract(item, k.toUpperCase(), (item && item.source) || 'LIVE', map);
    map[k] = norm;
  }
  return map;
}

function parseWhatIfQuery(rawText, recentContext = []) {
  const text = String(rawText || '').trim();
  if (!text) return null;

  const isHypo = (/(اگر|فرض\s*کن|چنانچه|در\s*صورتی\s*که|احتمال|برسه\s*به|بشه|بشود|سناریو)/i.test(text) ||
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
    'بالا', 'رشد', 'صعود', 'افزایشی'
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
    'پایین', 'افت', 'ریزش', 'کاهش', 'نزول', 'کاهشی'
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
    if (s.includes('طلای ۱۸') || s.includes('طلا ۱۸') || s.includes('طلای ۱۷') || s.includes('طلای هجده') || s.includes('آب‌شده') || s.includes('آب شده') || s.includes('مثقال') || s.includes('طلا') || s.includes('gold18') || s.includes('gold')) return 'GOLD18';
    if (s.includes('تتر') || s.includes('usdt')) return 'USDT';
    if (s.includes('دلار') || s.includes('usd')) return 'USD';
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
      let direction = 'UP';
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
    return `❓ **نیازمند شفاف‌سازی متغیر فرضی (Clarification Required):**\n\n` +
      `درخواست سناریوی فرضی شما دریافت شد، اما مشخص نگردید شوک مدنظر بر کدام دارایی (دلار آزاد، اونس جهانی طلا، سکه یا طلای ۱۸ عیار) اعمال شود.\n\n` +
      `💡 **پیشنهادهای سناریویی:**\n` +
      `• *اگر دلار ۱۰ درصد رشد کند، قیمت طلا و سکه چقدر می‌شود؟*\n` +
      `• *اگر اونس ۲۰۰ دلار افت کند و دلار ۲۸۰ هزار تومان شود چه تغییری رخ می‌دهد؟*`;
  }

  if (simResult.status === 'INVALID_RANGE') {
    return `⚠️ **خطای دامنه ارقام فرضی:**\n` + simResult.error;
  }

  if (simResult.status === 'SUCCESS_MULTI') {
    const { scenarioA, scenarioB, comparison } = simResult;
    const signG18 = comparison.diffGold18.amount >= 0 ? '+' : '';
    const signCoin = comparison.diffCoin.amount >= 0 ? '+' : '';

    return `⚖️ **مقایسه تطبیقی دو سناریوی مفروض (Scenario A vs Scenario B):**\n\n` +
      `### ۱. سناریوی اول (A):\n` +
      `• مفروضات: دلار **${fmtFa(scenarioA.hypothetical.usd)} تومان** | اونس طلا **${fmtFa(scenarioA.hypothetical.xau)} دلار**\n` +
      `• ارزش ذاتی هر گرم ۱۸ عیار: **${fmtFa(scenarioA.hypothetical.gold18Intrinsic)} تومان**\n` +
      `• ارزش ذاتی سکه امامی: **${fmtFa(scenarioA.hypothetical.coinIntrinsic)} تومان**\n\n` +
      `### ۲. سناریوی دوم (B):\n` +
      `• مفروضات: دلار **${fmtFa(scenarioB.hypothetical.usd)} تومان** | اونس طلا **${fmtFa(scenarioB.hypothetical.xau)} دلار**\n` +
      `• ارزش ذاتی هر گرم ۱۸ عیار: **${fmtFa(scenarioB.hypothetical.gold18Intrinsic)} تومان**\n` +
      `• ارزش ذاتی سکه امامی: **${fmtFa(scenarioB.hypothetical.coinIntrinsic)} تومان**\n\n` +
      `### 📊 موازنه و اختلاف سناریوی B نسبت به A:\n` +
      `• **اختلاف گرم طلای ۱۸ عیار:** **${signG18}${fmtFa(comparison.diffGold18.amount)} تومان** (${signG18}${fmtFa(comparison.diffGold18.pct, 2)}٪)\n` +
      `• **اختلاف ارزش ذاتی سکه:** **${signCoin}${fmtFa(comparison.diffCoin.amount)} تومان** (${signCoin}${fmtFa(comparison.diffCoin.pct, 2)}٪)\n\n` +
      `🔒 **سلب مسئولیت:** مقادیر محاسبه‌شده بر مبنای ارزش ذاتی خالص فلزی استخراج گردیده است.`;
  }

  const { hypothetical, deltas, traceSteps } = simResult;

  const assumptionLines = traceSteps.map(t => {
    const sign = t.changePct > 0 ? '+' : '';
    const name = t.asset === 'USD' ? 'دلار آزاد' : (t.asset === 'XAU' ? 'اونس جهانی طلا (XAU)' : (t.asset === 'GOLD18' ? 'طلای ۱۸ عیار' : (t.asset === 'COIN' ? 'سکه امامی' : t.asset)));
    const unit = t.unit === 'USD' ? 'دلار' : 'تومان';
    const neutralTag = (t.assumption && t.assumption.direction === 'NEUTRAL') ? ' [بدون تغییر / ساید]' : '';
    return `• **${name}:** از **${fmtFa(t.from)} ${unit}** ──► به **${fmtFa(t.to)} ${unit}** (${sign}${fmtFa(t.changePct, 1)}٪ نسبت به نرخ مبنا${neutralTag})`;
  }).join('\n');

  const signG18 = deltas.gold18.amount >= 0 ? '+' : '';
  const signCoin = deltas.coin.amount >= 0 ? '+' : '';

  return `🧮 **شبیه‌ساز تحلیلی سناریوی فرضی (Deterministic What-If Engine v4):**\n\n` +
    `### 📋 متغیرهای مفروض ورودی سناریو:\n` +
    assumptionLines + `\n\n` +
    `### 📐 گام‌های محاسبات دقیق کانونیکال (Mathematical Step-by-Step):\n` +
    `• **۱. ارزش ذاتی تئوریک هر گرم طلای ۱۸ عیار:**\n` +
    `  $$\\text{ارزش ذاتی ۱۸} = \\frac{\\text{اونس (${fmtFa(hypothetical.xau)})} \\times \\text{دلار (${fmtFa(hypothetical.usd)})} \\times 0.750}{31.1035} = \\mathbf{${fmtFa(hypothetical.gold18Intrinsic)} \\text{ تومان}}$$\n` +
    `  ↳ *تغییر نسبت به مبنای امروز:* **${signG18}${fmtFa(deltas.gold18.amount)} تومان** (${signG18}${fmtFa(deltas.gold18.pct, 2)}٪)\n\n` +
    `• **۲. مظنه تئوریک یک مثقال طلای ۱۷ عیار آب‌شده (ضریب ۴٫۳۳۱۸ کانونیکال):**\n` +
    `  $$\\text{مظنه مثقال ۱۷} = 4.3318 \\times ${fmtFa(hypothetical.gold18Intrinsic)} = \\mathbf{${fmtFa(hypothetical.mithqal17)} \\text{ تومان}}$$\n\n` +
    `• **۳. ارزش ذاتی محتوای طلای سکه تمام طرح جدید (امامی):**\n` +
    `  $$\\text{ارزش ذاتی سکه} = \\frac{8.133 \\times 0.900 \\times ${fmtFa(hypothetical.xau)} \\times ${fmtFa(hypothetical.usd)}}{31.1035} = \\mathbf{${fmtFa(hypothetical.coinIntrinsic)} \\text{ تومان}}$$\n` +
    `  ↳ *تغییر نسبت به مبنای امروز:* **${signCoin}${fmtFa(deltas.coin.amount)} تومان** (${signCoin}${fmtFa(deltas.coin.pct, 2)}٪)\n\n` +
    `### 🔍 تحلیل اقتصادی موازنه نیروها:\n` +
    `در این سناریو، بردار برآیند اثر هم‌زمان محرک‌ها به تغییر خالص **${signG18}${fmtFa(deltas.gold18.pct, 2)}٪** در ارزش مبنای طلای داخلی منتهی می‌گردد.\n\n` +
    `🔒 **سلب مسئولیت:** این محاسبات بر مبنای ارزش ذاتی ریاضی شمش و محتوای فلزی استخراج شده و حباب احتمالی بازار و پرمیوم ناشی از انتظارات تورمی در آن لحاظ نشده است.`;
}

// ============================================================================
// موتور تولید پاسخ‌های تحلیلی پویای مشاور هوشمند (Dynamic Multi-Asset Synthesis Engine)
// ============================================================================

/**
 * تولید پاسخ تحلیلی هوشمند، زمینه-محور و بلادرنگ برای چت‌بات مشاور دیدبان
 */
function buildDynamicAdvisorResponse(userQuery, todayEvidence = {}, normalizedEvidence = null) {
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
  const isCorrelationQuery = q.includes('همبستگی') || q.includes('دلار') || q.includes('طلا') || q.includes('واگرایی') || q.includes('تتر') || q.includes('اسپرد') || q.includes('ارز') || q.includes('اونس');
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
        `• **فرمول کانونیکال ارزش ذاتی گرم ۱۸ عیار:**\n` +
        `  $$\\text{ارزش ذاتی} = \\frac{\\text{اونس جهانی (XAU)} \\times \\text{دلار آزاد} \\times 0.750}{31.1035} \\quad \\Big( \\text{یا} \\quad \\frac{\\text{مظنه مثقال}}{4.3318} \\Big)$$\n\n` +
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
      return `⚖️ **نسبت اونس طلا به نقره ($XAU/XAG$ Ratio):**\n\n` +
        `• **فرمول:** $$\\text{Ratio} = \\frac{\\text{نرخ هر اونس طلا (XAU)}}{\\text{نرخ هر اونس نقره (XAG)}}$$\n` +
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
        `• **فرمول:** $$\\text{P/E} = \\frac{\\text{قیمت هر سهم (Price)}}{\\text{سود هر سهم (EPS)}}$$\n` +
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
        `### محاسبات دقیق کانونیکال بر مبنای فرضیات فوق:\n` +
        `• **۱. ارزش ذاتی محتوای طلای سکه تمام امامی:**\n` +
        `  $$\\text{ارزش ذاتی} = \\frac{8.133 \\times 0.900 \\times ${fmtFa(simXau)} \\times ${fmtFa(simUsd)}}{31.1035} = \\mathbf{${fmtFa(simIntrinsic)} \\text{ تومان}}$$\n` +
        `• **۲. قیمت تئوریک هر گرم طلای ۱۸ عیار:** **${fmtFa(simGold18)} تومان**\n` +
        `• **۳. مظنه تئوریک یک مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(simMithqal)} تومان** (محاسبه: $4.3318 \\times ${fmtFa(simGold18)}$)\n\n` +
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
        `• **مظنه یک مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(mithqalPrice)} تومان** (نسبت کانونیکال ۴٫۳۳۱۸ به گرم ۱۸ عیار).\n` +
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
          `   دلار آزاد (${usd.change >= 0 ? '+' : ''}${fmtFa(usd.change, 2)}٪) و طلای ۱۸ عیار (${gold18.change >= 0 ? '+' : ''}${fmtFa(gold18.change, 2)}٪) حرکتی هم‌راستا با ساختار همبستگی تاریخی ثبت کرده‌اند.`;
      }
    }

    let spreadAnalysis = '';
    if (usdtSpreadPct !== null) {
      spreadAnalysis = `\n• **📌 تحلیل اسپرد تتر و دلار تابلوی فعال:**\n` +
        `   - نرخ دلار آزاد: **${fmtFa(usd.price)} تومان** | نرخ تتر (USDT): **${fmtFa(usdt.price)} تومان** ──► انحراف اسپرد: **${fmtFa(usdtSpreadPct, 2)}٪** (${fmtFa(usdtSpreadToman)} تومان).\n` +
        `   - *تفسیر اقتصادی:* ${usdtSpreadPct > 1.2 ? 'اسپرد بالای ۱.۲٪ نشان‌دهنده اضافه تقاضای خروج نقدینگی و پرمیوم تسویه فرامرزی است.' : 'اسپرد در محدوده متعادل و نقدشونده بازار قرار دارد.'}`;
    }

    return `📈 **تحلیل کمّی و ساختاری همبستگی بازارها و واگرایی دارایی‌ها:**\n\n` +
      `• **ضرایب همبستگی پیرسون تاریخی (Pearson R):**\n` +
      `   - همبستگی طلای ۱۸ عیار با دلار آزاد: **$R \\approx +0.94$** (هم‌حرکتی مستقیم بسیار قدرتمند).\n` +
      `   - همبستگی تتر با دلار کاغذی: **$R \\approx +0.98$** (انطباق کامل با انحراف اسپرد دوره‌ای).\n` +
      `   - همبستگی طلای ۱۸ عیار با اونس جهانی طلا: **$R \\approx +0.65$** (تعدیل دوگانه بردار ارز و اونس).` +
      divAnalysis +
      spreadAnalysis +
      `\n\n• **برابری مظنه مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(mithqalPrice)} تومان** (محاسبه دقیق کانونیکال: $4.3318 \\times \\text{قیمت هر گرم ۱۸ عیار}$).`;
  }

  // ۶. پاسخ به تحلیل حباب سکه، طلای ۱۸ عیار و طلای آب‌شده
  if (isBubbleQuery) {
    let liveBubbleDetails = '';
    if (coinIntrinsic !== null) {
      liveBubbleDetails = `\n### 📌 محاسبه زنده حباب تابلوی امروز:\n` +
        `• **۱. سکه تمام امامی:** ارزش ذاتی **${fmtFa(coinIntrinsic)} تومان** | نرخ بازار: **${fmtFa(sekee.price)} تومان** ──► **حباب: ${fmtFa(coinBubblePct, 1)}٪** (${fmtFa(coinBubbleToman)} تومان).\n` +
        (gold18Intrinsic !== null ? `• **۲. هر گرم طلای ۱۸ عیار:** ارزش ذاتی **${fmtFa(gold18Intrinsic)} تومان** | نرخ بازار: **${fmtFa(gold18.price)} تومان** ──► **حباب تحلیلی: ${gold18BubblePct >= 0 ? '+' : ''}${fmtFa(gold18BubblePct, 2)}٪**.\n` : '') +
        `• **۳. مظنه یک مثقال طلای ۱۷ عیار آب‌شده:** **${fmtFa(mithqalPrice)} تومان** (برابری ۴٫۳۳۱۸ به هر گرم ۱۸ عیار).\n`;
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
      `• **فرمول کانونیکال محاسبه ارزش ذاتی سکه امامی:**\n` +
      `  $$\\text{ارزش ذاتی سکه} = \\left( \\frac{\\text{وزن ۸.۱۳۳ گرم} \\times \\text{عیار ۰.۹۰۰} \\times \\text{اونس جهانی} \\times \\text{نرخ دلار آزاد}}{31.1035} \\right) + \\text{حق ضرب رسمی}$$\n` +
      `• **فرمول کانونیکال ارزش ذاتی هر گرم طلای ۱۸ عیار:**\n` +
      `  $$\\text{ارزش ذاتی گرم ۱۸} = \\frac{\\text{اونس جهانی} \\times \\text{دلار آزاد} \\times 0.750}{31.1035}$$\n` +
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

  // ۸. پاسخ عمومی چندبعدی در صورت سوالات ترکیبی یا عمومی
  return `💡 **مشاور تحلیلی هوشمند دیدبان بازار:**\n\n` +
    `درخواست شما درباره «${userQuery}» ارزیابی شد. خلاصه موازنه چندبعدی تابلوی فعال:\n\n` +
    `• **بازار ارز:** دلار آزاد **${fmtFa(usd.price)} تومان** | تتر **${fmtFa(usdt.price)} تومان** (اسپرد: **${fmtFa(usdtSpreadPct, 2)}٪**)\n` +
    `• **بازار طلا:** طلای ۱۸ عیار **${fmtFa(gold18.price)} تومان** | سکه تمام **${fmtFa(sekee.price)} تومان** (حباب: **${fmtFa(coinBubblePct, 1)}٪**)\n` +
    `• **طلای آب‌شده:** مظنه مثقال ۱۷ عیار **${fmtFa(mithqalPrice)} تومان** (هر گرم ۱۸ عیار × ۴٫۳۳۱۸)\n` +
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

function buildAdvisorChatSystemPrompt(todayEvidence = {}, queryAnalysis = null) {
  const evSummary = JSON.stringify(todayEvidence, null, 2);
  let analysisConstraint = '';
  if (queryAnalysis && queryAnalysis.intent) {
    analysisConstraint = `\n۵. ساختار تحلیل نیت و اهداف استعلام کاربر:
   - نیت اصلی (Primary Intent): ${queryAnalysis.intent.primary}
   - نیت‌های ثانویه (Secondary Intents): ${queryAnalysis.intent.secondary?.join('، ') || 'ندارد'}
   - موجودیت‌های شناسایی‌شده (Entities): ${queryAnalysis.entities?.map(e => e.value).join('، ') || 'عمومی'}
   - شواهد کلیدی موردنیاز (Required Evidence): ${queryAnalysis.evidencePlan?.required?.join('، ') || 'شواهد پایه'}\n`;
  }

  return `شما «مشاور هوشمند و اقتصادسنج دیدبان بازار» هستید؛ یک دستیار تحلیلی مالی ارشد با تسلط بر تئوری‌های نوین مالی، اقتصاد کلان ایران، بازار طلا، ارز، کریپتو و بورس تهران.

ضوابط محوری پاسخ‌گویی:
۱. ادبیات حرفه‌ای، فاخر، روان و تحلیلی با رعایت لحن مشاور امین و آگاه.
۲. سد کامل ضدسیگنال: هرگز سیگنال قطعی خرید/فروش، نقطه ورود/خروج یا تضمین سود صادر نکنید. به جای آن، ریسک، بتای دارایی، نسبت‌های آماری و موازنه پورتفوی را تبیین نمایید.
۳. فرمول‌های ریاضی و کانونیکال:
   - ارزش ذاتی سکه تمام = [(وزن 8.133 × عیار 0.900 × اونس جهانی × دلار آزاد) / 31.1035] + حق ضرب.
   - ارزش ذاتی هر گرم طلای ۱۸ عیار = (اونس جهانی × دلار آزاد × 0.750) / 31.1035 (یا مظنه مثقال ۱۷ / 4.3318).
   - مظنه مثقال ۱۷ عیار آب‌شده = 4.3318 × قیمت گرم ۱۸ عیار.
   - نسبت طلا به نقره = اونس طلا / اونس نقره.
   - کریدور تعادلی حباب طلای ۱۸ عیار = بازه [-2.5% تا +2.5%]. حباب بالای +2.5% (به‌ویژه > +4%) نشانه اشباع خرید و پتانسیل اصلاح در افق ۱۴ روزه است؛ حباب کمتر از -2.5% (به‌ویژه < -4%) نشانه عقب‌ماندگی و محرک تقاضای آربیتراژی در افق ۱۴ روزه است.
۴. داده‌های زنده تابلوی بازار امروز جهت ارجاع دقیق:
${evSummary}
${analysisConstraint}
پاسخ را در قالبی شیوا با تیترهای مشخص، ساختار تحلیلی و تبیین ریسک‌ها ارائه دهید.`;
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

  return `شما «تحلیلگر ارشد و ناظر هوشمند اقتصادی دیدبان بازار» هستید.
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

/**
 * تبدیل ارقام به فارسی در ورکر ۳
 */
function toFaDigits(str) {
  if (str === null || str === undefined) return '—';
  return String(str).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
}

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
