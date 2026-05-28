// toEssence background.js v5.0
const BACKEND = 'https://xstqpvvxiftgppxnzpzv.supabase.co/functions/v1/filter'
const PLAN_LIMITS = { free: 10, easy: 50, pro: 150, owner: 500 }

async function getUUID() {
  return new Promise(resolve => {
    chrome.storage.local.get('uuid', d => {
      if (d.uuid) { resolve(d.uuid); return }
      const id = crypto.randomUUID()
      chrome.storage.local.set({ uuid: id })
      resolve(id)
    })
  })
}

// Серверний статус: реальні used/limit/plan (без AI, без списання)
async function fetchServerStatus() {
  const uuid = await getUUID()
  const r = await fetch(BACKEND, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uuid, type: 'status', tzOffset: new Date().getTimezoneOffset() })
  })
  if (!r.ok) throw new Error('status ' + r.status)
  return await r.json() // { used, limit, plan, isPro, resetDay }
}

function updateCount(filtersToday, isPro, country, plan) {
  chrome.storage.local.get(['plan'], d => {
    const isOwner = d.plan === 'owner'
    const upd = { filters_today: filtersToday }
    if (country) upd.country = country
    if (!isOwner) {
      upd.is_pro = isPro
      upd.plan = plan || 'free'
    }
    chrome.storage.local.set(upd)
  })
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {

  // При старті перевіряємо чи скинувся "сплячий режим"
  chrome.storage.local.get(['limit_disabled_until', 'enabled'], d => {
    if (d.limit_disabled_until && Date.now() >= d.limit_disabled_until) {
      chrome.storage.local.set({ enabled: true, limit_disabled_until: null })
    }
  })

  if (msg.type === 'GET_STATUS') {
    // 1) Миттєво віддаємо кеш зі storage (popup малює одразу, без очікування мережі)
    chrome.storage.local.get(['filters_today','is_pro','plan','country','enabled','limit'], d => {
      const plan = d.plan || 'free'
      const cachedLimit = d.limit || PLAN_LIMITS[plan] || 10
      reply({
        filtersToday: d.filters_today || 0,
        limit: cachedLimit,
        isPro: d.is_pro || false,
        plan: plan,
        country: d.country || '',
        enabled: d.enabled !== false,
        fromCache: true
      })
    })

    // 2) У фоні питаємо сервер і оновлюємо storage → popup перемалюється через onChanged
    fetchServerStatus().then(s => {
      if (!s) return
      chrome.storage.local.get(['plan'], d => {
        const isOwner = d.plan === 'owner'
        const upd = {
          filters_today: typeof s.used === 'number' ? s.used : 0,
          limit: s.limit || PLAN_LIMITS[s.plan] || 10
        }
        if (!isOwner) {
          upd.is_pro = s.isPro || false
          upd.plan = s.plan || 'free'
        }
        chrome.storage.local.set(upd)
      })
    }).catch(() => {})

    return true
  }

  if (msg.type === 'SET_ENABLED') {
    chrome.storage.local.set({ enabled: msg.value })
    return false
  }

  if (msg.type === 'FETCH_URL') {
    fetch(msg.url, {
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'uk,en;q=0.9',
        'Accept-Charset': 'utf-8',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    })
      .then(r => {
        const charset = r.headers.get('content-type')?.match(/charset=([^\s;]+)/i)?.[1] || 'utf-8'
        return r.arrayBuffer().then(buf => {
          const decoder = new TextDecoder(charset === 'windows-1251' || charset === 'cp1251' ? 'windows-1251' : 'utf-8')
          return decoder.decode(buf)
        })
      })
      .then(html => reply({ html }))
      .catch(() => reply({ html: null }))
    return true
  }

  if (msg.type === 'FILTER') {
    const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000)
    getUUID().then(uuid => {
      fetch(BACKEND, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid, ...msg.payload })
      })
      .then(async r => {
        const contentType = r.headers.get('content-type') || ''

        if (contentType.includes('text/event-stream')) {
          const reader = r.body.getReader()
          const decoder = new TextDecoder()
          let buffer = '', text = '', meta = null
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n'); buffer = lines.pop() || ''
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue
              const json = line.slice(6).trim()
              if (json === '[DONE]') {
                if (meta) updateCount(meta.used, meta.isPro, '', meta.plan)
                clearInterval(keepAlive)
                reply({ ok: true, data: { data: meta ? { theses: [text.trim()], hadContent: meta.hadContent } : text.trim(), meta } })
                return
              }
              try {
                const d = JSON.parse(json)
                if (d.meta) { meta = d.meta }
                else if (d.chunk) { text += d.chunk }
              } catch { continue }
            }
          }
        } else {
          const data = await r.json()
          if (data.meta) updateCount(data.meta.used, data.meta.isPro, '', data.meta.plan)
          reply({ ok: true, data })
        }
      })
      .catch(err => { clearInterval(keepAlive); reply({ ok: false, error: err.message }) })
    })
    return true
  }

  return false
})
