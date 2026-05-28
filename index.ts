import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const OPENAI_KEY   = Deno.env.get('OPENAI_API_KEY')!
const GROQ_KEY      = Deno.env.get('GROQ_API_KEY')!
const SUPADATA_KEY  = Deno.env.get('SUPADATA_API_KEY')!

async function fetchSubtitles(videoId: string): Promise<string> {
  try {
    const r = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${videoId}&text=true`, {
      headers: { 'x-api-key': SUPADATA_KEY }
    })
    if (!r.ok) return ''
    const d = await r.json()
    return (d.content || d.text || '').slice(0, 4000)
  } catch { return '' }
}

const FREE_LIMIT   = 10
const PLAN_LIMITS: Record<string, number> = { free: 10, easy: 50, pro: 150, owner: 500 }
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY)

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json'
}

const LANG: Record<string, string> = {
  uk:'Ukrainian', en:'English', pl:'Polish', de:'German', fr:'French',
  es:'Spanish',  it:'Italian', pt:'Portuguese', ru:'Russian', cs:'Czech',
  nl:'Dutch',    sv:'Swedish', fi:'Finnish', no:'Norwegian', da:'Danish',
  hu:'Hungarian',tr:'Turkish', ar:'Arabic',  zh:'Chinese',  ja:'Japanese',
  hi:'Hindi',    ko:'Korean',  ro:'Romanian', bg:'Bulgarian', hr:'Croatian',
  sk:'Slovak',   id:'Indonesian', th:'Thai', vi:'Vietnamese', el:'Greek'
}

function hashIP(ip: string): string {
  let h = 0
  for (let i = 0; i < ip.length; i++) { h = ((h << 5) - h) + ip.charCodeAt(i); h |= 0 }
  return Math.abs(h).toString(36)
}

// ── ЛІЧИЛЬНИК ─────────────────────────────────────────────────
// Локальна дата клієнта з tzOffset (хвилини, як дає getTimezoneOffset).
function localDayKey(tzOffset: number): string {
  const now = new Date()
  const local = new Date(now.getTime() - (tzOffset || 0) * 60000)
  return local.toISOString().slice(0, 10) // "YYYY-MM-DD"
}

// ФАЗА 1: тільки перевірка ліміту (нічого не списує). Викликати ДО OpenAI.
async function checkFilter(uuid: string, dayKey: string, cost: number) {
  const { data, error } = await supabase.rpc('check_filter', {
    p_uuid: uuid, p_day_key: dayKey, p_cost: cost
  })
  if (error || !data?.[0]) {
    // RPC впав — не блокуємо користувача (soft), але позначаємо
    return { used: 0, limit: FREE_LIMIT, plan: 'free', is_pro: false, allowed: true, soft: true }
  }
  const r = data[0]
  return { used: r.used, limit: r.day_limit, plan: r.plan, is_pro: r.is_pro, allowed: r.allowed, soft: false }
}

// ФАЗА 2: лог + списання (fire-and-forget, НЕ блокує стрім).
function billOnce(uuid: string, dayKey: string, cost: number, type: string, site: string, ipHash: string, country: string) {
  supabase.from('filters').insert({ uuid, ip_hash: ipHash, type, site, country }).then(() => {})
  supabase.rpc('consume_filter', { p_uuid: uuid, p_day_key: dayKey, p_cost: cost, p_site: site || '' }).then(() => {})
}

// ── BOOK prompt ───────────────────────────────────────────────
function buildPrompt(type: string, data: any, langLabel: string): string {
  const title = data.title || ''
  const desc  = data.shortDesc || ''
  if (type === 'book') {
    return `Ти досвідчений книжковий критик з живим стилем письма. Видай відповідь СТРОГО у форматі (без markdown, без вступних фраз):

${title}

[Короткий опис книги 130-140 слів мовою ${langLabel}: про що книга, її головна ідея, особливості та чим вона захоплює.

КРИТИЧНО ВАЖЛИВО про стиль:
- ЗАБОРОНЕНО починати зі слів "Книга розповідає", "Ця книга", "У книзі", "Книга про", "Автор розповідає", "Роман розповідає" чи будь-яких подібних шаблонів.
- Починай ОДРАЗУ з суті, образу, інтриги, тези чи сцени — як починається жива рецензія.
- Пиши літературно, виразно, з характером. Кожен опис має бути унікальним за побудовою.
- Варіюй початок: можна з головного питання книги, з образу, з парадоксу, з контексту епохи, з головного героя, з ідеї.
- БЕЗ спойлерів кінцівки. НЕ вказувати автора, жанр, ціну, рік, видавництво, доставку.]

Якщо знаєш цю книгу — використовуй власні знання. Опис з картки: "${desc}"
НЕ ВИГАДУЙ. Якщо не знаєш книги — спирайся тільки на опис з картки.`
  }
  return ''
}

// Віддає кешований текст як стрім (без OpenAI)
function streamCached(text: string, meta: any): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ meta }) + '\n\n'))
      const chunks = text.match(/[\s\S]{1,200}/g) || []
      for (const c of chunks) ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ chunk: c }) + '\n\n'))
      ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
      ctrl.close()
    }
  })
  return new Response(stream, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    }
  })

  try {
    const body  = await req.json()
    const { uuid, title, url, lang, pageText, tzOffset } = body

    if (!uuid) return new Response(JSON.stringify({ error: 'Missing uuid' }), { status: 400, headers: CORS })

    const dayKey = localDayKey(tzOffset || 0)
    const ip     = req.headers.get('x-forwarded-for')?.split(',')[0] || ''
    const ipHash = hashIP(ip)
    const country = req.headers.get('cf-ipcountry') || 'UA'

    // ── STATUS ──────────────────────────────────────────────────
    // Легкий запит для popup: реальний стан без AI і без списання.
    if (body.type === 'status') {
      const s = await checkFilter(uuid, dayKey, 0)
      return new Response(JSON.stringify({
        used: s.used, limit: s.limit, plan: s.plan, isPro: s.is_pro,
        resetDay: dayKey
      }), { headers: CORS })
    }

    // ── READER ──────────────────────────────────────────────────
    if (body.type === 'reader') {
      const { rawText, lang: rLang } = body
      if (!rawText || rawText.length < 100) {
        return new Response(JSON.stringify({ success: true, data: { text: '', blocked: true } }), { headers: CORS })
      }

      const rCacheKey = (url || '') + '::reader::' + (rLang?.split('-')[0] || 'uk')
      if (url) {
        const rCached = await supabase.from('article_cache').select('summary').eq('cache_key', rCacheKey).single()
        if (rCached.data?.summary) {
          const enc2 = new TextEncoder()
          const cached2 = rCached.data.summary
          const stream2 = new ReadableStream({
            start(ctrl) {
              const chunks = cached2.match(/[\s\S]{1,200}/g) || []
              for (const chunk of chunks) ctrl.enqueue(enc2.encode('data: ' + JSON.stringify({ chunk }) + '\n\n'))
              ctrl.enqueue(enc2.encode('data: [DONE]\n\n'))
              ctrl.close()
            }
          })
          return new Response(stream2, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
        }
      }

      const rLangLabel = LANG[rLang?.split('-')[0]] || 'English'
      const readerPrompt = `Твоє завдання — провести повну текстову валідацію та очищення наданого матеріалу. Зібрати ОДНУ цілісну статтю від початку до кінця без жодних скорочень.\nСуворі інструкції:\n1. ПОВНИЙ ОБСЯГ: заборонено урізати текст або робити резюме.\n2. БЕЗ ВИГАДОК: не додавай жодного слова чи факту яких немає в оригіналі.\n3. ОЧИЩЕННЯ ДУБЛІВ: якщо речення або абзац повторюється — виведи його лише один раз.\n4. ТОЧНІСТЬ ДАНИХ: збережи 100% точно всі імена, дати, цифри, відсотки, цитати.\n5. АРХІТЕКТУРА: заголовок як # Заголовок, підзаголовки як ## Підзаголовок.\nВиведи ТІЛЬКИ текст статті без жодних вступних фраз. Залишай слова "Сьогодні", "Вчора" як в оригіналі. Мова виводу: ${rLangLabel}.\n\n${rawText}`
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, max_tokens: 8000, temperature: 0, messages: [{ role: 'user', content: readerPrompt }] })
      })
      if (!r.ok) throw new Error('OpenAI reader ' + r.status)
      const enc = new TextEncoder()
      const dec = new TextDecoder()
      const stream = new ReadableStream({
        async start(ctrl) {
          const reader = r.body!.getReader()
          let buf = '', fullText = ''
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() || ''
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                const json = line.slice(6).trim()
                if (!json || json === '[DONE]') continue
                try {
                  const chunk = JSON.parse(json).choices?.[0]?.delta?.content || ''
                  if (chunk) { fullText += chunk; ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ chunk }) + '\n\n')) }
                } catch { continue }
              }
            }
            if (url && fullText.length > 100) supabase.from('article_cache').upsert(
              { cache_key: rCacheKey, url, summary: fullText.trim(), lang: rLang?.split('-')[0] || 'uk' },
              { onConflict: 'cache_key' }
            ).then(() => {})
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
          } finally { reader.releaseLock(); ctrl.close() }
        }
      })
      return new Response(stream, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } })
    }

    // ── YOUTUBE ─────────────────────────────────────────────────
    if (body.type === 'youtube') {
      const { url: ytUrl, title: ytTitle, lang: ytLang } = body
      let videoId = ''
      try { videoId = new URL(ytUrl).searchParams.get('v') || '' } catch {}
      if (!videoId) return new Response(JSON.stringify({ error: 'Missing videoId' }), { status: 400, headers: CORS })

      const ytLangLabel = LANG[ytLang?.split('-')[0]] || 'English'
      const ytCacheKey = 'yt:' + videoId + '::' + (ytLang?.split('-')[0] || 'uk')

      const ytCost = 3 // owner теж лічиться (безліміту немає), але cost для відео = 3

      // ФАЗА 1: перевірка ліміту + кеш паралельно
      const [chk, ytCached] = await Promise.all([
        checkFilter(uuid, dayKey, ytCost),
        supabase.from('article_cache').select('summary').eq('cache_key', ytCacheKey).single()
      ])

      // Free тариф — YouTube недоступний
      if (chk.plan === 'free' || !chk.plan) {
        return new Response(JSON.stringify({ error: 'YT_NOT_FREE' }), { status: 403, headers: CORS })
      }

      // owner платить лише 1, решта — 3 (перерахунок після того як знаємо план)
      const realCost = chk.plan === 'owner' ? 1 : 3
      if (!chk.allowed) {
        return new Response(JSON.stringify({ error: 'LIMIT_REACHED', used: chk.used, limit: chk.limit }), { status: 402, headers: CORS })
      }

      // Кеш — миттєва відповідь (списуємо realCost, з дедуплікацією)
      if (ytCached.data?.summary) {
        billOnce(uuid, dayKey, realCost, 'youtube', ytUrl, ipHash, country)
        return streamCached(ytCached.data.summary, { used: chk.used + realCost, limit: chk.limit, isPro: chk.is_pro, plan: chk.plan, hadContent: true })
      }

      const subs = await fetchSubtitles(videoId)
      const hadContent = subs.length > 100

      const ytPrompt = hadContent
        ? `Видай короткий опис відео від 130 до 140 слів мовою ${ytLangLabel}. Тільки факти з субтитрів, нічого вигаданого. Пиши природною живою мовою, не дослівним перекладом. Без вступних фраз.
Назва: ${ytTitle}
Субтитри: ${subs}`
        : `Видай короткий опис відео від 130 до 140 слів мовою ${ytLangLabel}. Тільки факти з назви, нічого вигаданого.
Назва: ${ytTitle}`

      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, max_tokens: 400, temperature: 0, messages: [{ role: 'user', content: ytPrompt }] })
      })
      if (!r.ok) throw new Error('OpenAI yt ' + r.status)

      const enc = new TextEncoder()
      const dec = new TextDecoder()
      const stream = new ReadableStream({
        async start(ctrl) {
          const reader = r.body!.getReader()
          let buf = '', fullText = '', billed = false
          ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ meta: { used: chk.used + realCost, limit: chk.limit, isPro: chk.is_pro, plan: chk.plan, hadContent } }) + '\n\n'))
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() || ''
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                const json = line.slice(6).trim()
                if (!json || json === '[DONE]') continue
                try {
                  const chunk = JSON.parse(json).choices?.[0]?.delta?.content || ''
                  if (chunk) {
                    fullText += chunk
                    ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ chunk }) + '\n\n'))
                    if (!billed) { billed = true; billOnce(uuid, dayKey, realCost, 'youtube', ytUrl, ipHash, country) }
                  }
                } catch { continue }
              }
            }
            if (fullText.length > 50) supabase.from('article_cache').upsert(
              { cache_key: ytCacheKey, url: ytUrl, summary: fullText.trim(), lang: ytLang?.split('-')[0] || 'uk' },
              { onConflict: 'cache_key' }
            ).then(() => {})
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
          } catch (_) {
          } finally { reader.releaseLock(); try { ctrl.close() } catch (_) {} }
        },
        cancel() { try { r.body?.cancel() } catch (_) {} }
      })
      return new Response(stream, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } })
    }

    // ── BOOK ────────────────────────────────────────────────────
    if (body.type === 'book') {
      const rType = body.type
      const rTitle = body.title || ''
      if (!rTitle) return new Response(JSON.stringify({ error: 'Missing title' }), { status: 400, headers: CORS })
      const rLangLabel = LANG[body.lang?.split('-')[0]] || 'English'
      const rCacheKey = rType + ':' + (body.url || rTitle) + '::' + (body.lang?.split('-')[0] || 'uk')

      // ФАЗА 1: перевірка + кеш
      const [chk, rCached] = await Promise.all([
        checkFilter(uuid, dayKey, 1),
        supabase.from('article_cache').select('summary').eq('cache_key', rCacheKey).single()
      ])

      if (rCached.data?.summary) {
        billOnce(uuid, dayKey, 1, rType, body.url || '', ipHash, country)
        return streamCached(rCached.data.summary, { used: chk.used + 1, limit: chk.limit, isPro: chk.is_pro, plan: chk.plan, hadContent: true })
      }

      if (!chk.allowed) {
        return new Response(JSON.stringify({ error: 'LIMIT_REACHED', used: chk.used, limit: chk.limit }), { status: 402, headers: CORS })
      }

      const rPrompt = buildPrompt(rType, body, rLangLabel)
      const rRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, max_tokens: 500, temperature: 0.8, messages: [{ role: 'user', content: rPrompt }] })
      })
      if (!rRes.ok) throw new Error('OpenAI ' + rType + ' ' + rRes.status)

      const enc = new TextEncoder()
      const dec = new TextDecoder()
      const stream = new ReadableStream({
        async start(ctrl) {
          const reader = rRes.body!.getReader()
          let buf = '', fullText = '', billed = false
          ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ meta: { used: chk.used + 1, limit: chk.limit, isPro: chk.is_pro, plan: chk.plan, hadContent: true } }) + '\n\n'))
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              buf += dec.decode(value, { stream: true })
              const lines = buf.split('\n'); buf = lines.pop() || ''
              for (const line of lines) {
                if (!line.startsWith('data: ')) continue
                const json = line.slice(6).trim()
                if (!json || json === '[DONE]') continue
                try {
                  const chunk = JSON.parse(json).choices?.[0]?.delta?.content || ''
                  if (chunk) {
                    fullText += chunk
                    ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ chunk }) + '\n\n'))
                    if (!billed) { billed = true; billOnce(uuid, dayKey, 1, rType, body.url || '', ipHash, country) }
                  }
                } catch { continue }
              }
            }
            if (fullText.length > 50) supabase.from('article_cache').upsert(
              { cache_key: rCacheKey, url: body.url || rTitle, summary: fullText.trim(), lang: body.lang?.split('-')[0] || 'uk' },
              { onConflict: 'cache_key' }
            ).then(() => {})
            ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
          } catch (_) {
          } finally { reader.releaseLock(); try { ctrl.close() } catch (_) {} }
        },
        cancel() { try { rRes.body?.cancel() } catch (_) {} }
      })
      return new Response(stream, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } })
    }

    // ── NEWS (дефолт) ───────────────────────────────────────────
    if (!title) return new Response(JSON.stringify({ error: 'Missing title' }), { status: 400, headers: CORS })

    const rawInput = (pageText && pageText.length > 100) ? pageText.slice(0, 3000) : ''
    const textInput = rawInput.replace(/[^\p{L}\p{N}\p{P}\p{Z}\n]/gu, ' ').replace(/\s{2,}/g, ' ').trim()
    const langLabel = LANG[lang?.split('-')[0]] || 'English'
    const cacheKey  = url + '::' + (lang?.split('-')[0] || 'uk')

    const prompt0 = textInput
      ? `ПРІОРИТЕТ НА ТВЕРДІ ДАНІ: збережи у 100% точності всі власні назви, дати, час, цифри, відсотки та цитати. Видай один абзац від 130 до 140 слів ${langLabel} мовою. Пиши природною, живою мовою — ніби текст одразу написаний цією мовою, а не перекладений. Уникай калькованих зворотів і дослівного перекладу. Без вступних фраз. Не повторювати назву статті. Починай текст з великої букви і повного речення, навіть якщо отриманий текст починається з середини.\nЗаголовок: ${title}\nТекст: ${textInput}`
      : `Видай короткий опис події від 130 до 140 слів мовою ${langLabel}. Тільки факти з заголовку, нічого вигаданого.\nЗаголовок: ${title}`

    // ФАЗА 1 + кеш + запуск OpenAI — все паралельно (швидкість!)
    const [chk, cachedRes, r2] = await Promise.all([
      checkFilter(uuid, dayKey, 1),
      url ? supabase.from('article_cache').select('summary').eq('cache_key', cacheKey).single() : Promise.resolve({ data: null }),
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENAI_KEY },
        body: JSON.stringify({ model: 'gpt-4o-mini', stream: true, max_tokens: 400, temperature: 0, messages: [{ role: 'user', content: prompt0 }] })
      })
    ])

    // Кеш — миттєва відповідь
    if (cachedRes.data?.summary) {
      billOnce(uuid, dayKey, 1, 'news', url, ipHash, country)
      return new Response(JSON.stringify({
        success: true,
        data: { theses: [cachedRes.data.summary], hadContent: true },
        meta: { used: chk.used + 1, limit: chk.limit, isPro: chk.is_pro, plan: chk.plan }
      }), { headers: CORS })
    }

    if (!chk.allowed) {
      return new Response(JSON.stringify({ error: 'LIMIT_REACHED', used: chk.used, limit: chk.limit }), { status: 402, headers: CORS })
    }

    if (!r2.ok) throw new Error('OpenAI ' + r2.status)

    const enc = new TextEncoder()
    const dec = new TextDecoder()

    const newsStream = new ReadableStream({
      async start(ctrl) {
        // meta першим чанком — popup оновиться одразу, текст не чекає
        ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ meta: { used: chk.used + 1, limit: chk.limit, isPro: chk.is_pro, plan: chk.plan }, hadContent: !!textInput }) + '\n\n'))
        const rdr = r2.body!.getReader()
        let buf = '', fullText = '', billed = false
        try {
          while (true) {
            const { done, value } = await rdr.read()
            if (done) break
            buf += dec.decode(value, { stream: true })
            const lines = buf.split('\n'); buf = lines.pop() || ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const json = line.slice(6).trim()
              if (!json || json === '[DONE]') continue
              try {
                const chunk = JSON.parse(json).choices?.[0]?.delta?.content || ''
                if (chunk) {
                  fullText += chunk
                  ctrl.enqueue(enc.encode('data: ' + JSON.stringify({ chunk }) + '\n\n'))
                  // Списуємо РІВНО ОДИН раз — на першому реальному чанку
                  if (!billed) { billed = true; billOnce(uuid, dayKey, 1, 'news', url, ipHash, country) }
                }
              } catch { continue }
            }
          }
          if (url && fullText) supabase.from('article_cache').upsert(
            { cache_key: cacheKey, url, summary: fullText.trim(), lang: lang?.split('-')[0] || 'uk' },
            { onConflict: 'cache_key' }
          ).then(() => {})
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'))
        } catch (_) {
          // Клієнт обірвав з'єднання — нічого не робимо (списано лише якщо вже був чанк)
        } finally { rdr.releaseLock(); try { ctrl.close() } catch (_) {} }
      },
      cancel() {
        // Клієнт відключився до завершення — серверне читання припиняємо нижче через try/catch
        try { r2.body?.cancel() } catch (_) {}
      }
    })
    return new Response(newsStream, { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' } })

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Internal error' }), { status: 500, headers: CORS })
  }
})
