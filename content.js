// toEssence content.js v4.9
;(function () {
  'use strict'

  // ⚡ Глобальний захист від втрати контексту розширення
  if (typeof chrome === 'undefined' || !chrome.runtime) return

  // ⚡ Перехоплюємо помилку інвалідації контексту (YouTube SPA навігація)
  function safeSend(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, cb)
    } catch (e) {
      if (cb) cb(null)
    }
  }

  const HOST    = location.hostname
  const IS_YT   = HOST.includes('youtube.com')
  const LANG    = navigator.language || 'uk'
  const HOVER_MS = 1000
  const HIDE_MS  = 200

  let enabled = true
  let card = null
  let hideTimer = null
  let hoverTimer = null
  let curEl = null
  const cache = new Map()
  const billed = new Set()
  let billTimer = null
  let magOn = false
  let lastX = 0, lastY = 0
  let _readerPageText = ''
  let _lightTheme = true

  // Стан перемикача мови
  let origLang = null
  let showingOrig = false
  let currentUrl = null

  safeSend({type:'GET_STATUS'}, r => { if (r) enabled = r.enabled })

  // Прокидання: якщо час сну (до місцевої півночі) минув — знову вмикаємо
  chrome.storage.local.get(['limit_disabled_until'], d => {
    if (d.limit_disabled_until && Date.now() >= d.limit_disabled_until) {
      chrome.storage.local.set({ enabled: true, limit_disabled_until: null })
      enabled = true
    }
  })

  // ── Streaming listener ───────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'STREAM_CHUNK' && card && card.classList.contains('toe-visible')) {
      const body = card.querySelector('#toe-body')
      if (!body) return
      const span = body.querySelector('.toe-row span')
      if (span) {
        span.textContent += msg.chunk
      } else {
        // Перший чанк — створюємо структуру
        body.innerHTML = '<div class="toe-list"><div class="toe-row"><div class="toe-dot"></div><span>' + msg.chunk + '</span></div></div>'
      }
      requestAnimationFrame(reposition)
    }
  })
  chrome.storage.onChanged.addListener(ch => { if ('enabled' in ch) enabled = ch.enabled.newValue })

  // ── CARD ─────────────────────────────────────────────────────
  function mountCard() {
    if (card && document.body.contains(card)) return
    card = document.createElement('div')
    card.id = 'toe-card'
    card.innerHTML =
      '<div id="toe-head">' +
        '<div id="toe-logo"><a href="https://toessence.net" target="_blank" style="text-decoration:none"><span class="toe-grey">to</span><span class="toe-green">E</span><span class="toe-grey">ssence</span></a></div>' +
        '<div id="toe-head-btns">' +
          '<button id="toe-lang" title="Мова оригіналу" style="display:none">EN</button>' +
          '<button id="toe-mag"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><line x1="15" y1="15" x2="22" y2="22"/></svg></button>' +
          '<button id="toe-copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>' +
          '<button id="toe-theme"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg></button>' +
          '<button id="toe-read-btn" style="display:none"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></button>' +
        '</div>' +
      '</div>' +
      '<div id="toe-body"></div>' +
      '<div id="toe-foot">toEssence</div>'
    document.body.appendChild(card)
    card.classList.toggle('toe-light', _lightTheme)
    card.addEventListener('mouseenter', () => clearTimeout(hideTimer))
    card.addEventListener('mouseleave', () => scheduleHide())
    card.querySelector('#toe-mag').addEventListener('click', e => { e.stopPropagation(); toggleMag() })
    card.querySelector('#toe-read-btn').addEventListener('click', e => {
      e.stopPropagation()
      if (!currentUrl) return
      chrome.storage.local.get(['filters_today','first_filter_time','is_pro','plan'], s => {
        const now = Date.now()
        const isNewDay = !s.first_filter_time || (new Date(s.first_filter_time).toDateString() !== new Date(now).toDateString())
        const today = isNewDay ? 0 : (s.filters_today || 0)
        const isPro = s.is_pro || false
        const plan = s.plan || 'free'
        const limits = { free:10, easy:50, pro:150, owner:500 }
        const limit = limits[plan] || 10
        if (!isPro && today >= limit) { showLimit('https://toessence.net', ''); return }
        chrome.storage.local.set({
          filters_today: today + 1,
          first_filter_time: isNewDay || today === 0 ? new Date().toISOString() : (s.first_filter_time || new Date().toISOString())
        })
        showReader('', currentUrl)
      })
    })
    card.querySelector('#toe-theme').addEventListener('click', e => {
      e.stopPropagation()
      _lightTheme = !_lightTheme
      card.classList.toggle('toe-light', _lightTheme)
      updateThemeBtn()
    })
    card.querySelector('#toe-lang').addEventListener('click', e => { e.stopPropagation(); toggleLang() })
    setTimeout(() => updateThemeBtn(), 0)
    card.querySelector('#toe-copy').addEventListener('click', async e => {
      e.stopPropagation()
      const btn = card.querySelector('#toe-copy')

      try {
        const text = card.querySelector('#toe-body')?.innerText || ''
        const url = currentUrl || location.href
        const domain = (() => { try { return new URL(url).hostname } catch { return url } })()

        // URL в кінці — Telegram підтягне превью з картинкою і посиланням
        const html = `<p>${text.replace(/\n/g, '<br>')}</p><p><a href="${url}">${url}</a></p><p><b style="color:#22c55e">toEssence.net</b></p>`
        const plain = text + '\n\n' + url + '\n\ntoEssence.net'

        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([html], { type: 'text/html' }),
            'text/plain': new Blob([plain], { type: 'text/plain' })
          })
        ])

        btn.style.color = '#22c55e'
        const msg = document.createElement('div')
        msg.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:#22c55e;color:#080a0f;font-size:11px;font-family:IBM Plex Mono,monospace;font-weight:600;padding:8px 16px;border-radius:6px;white-space:nowrap;z-index:2147483647'
        msg.textContent = 'Скопійовано в буфер обміну'
        card.style.position = 'fixed'
        card.appendChild(msg)
        setTimeout(() => { msg.remove(); btn.style.color = '' }, 2500)

      } catch (err) {
        // Fallback — копіюємо текст
        const text = card.querySelector('#toe-body')?.innerText || ''
        const url = currentUrl || location.href
        navigator.clipboard.writeText(text + '\n\n📎 ' + url)
        btn.style.color = '#22c55e'
        setTimeout(() => { btn.style.color = '' }, 1500)
      }
    })
  }

  function esc(t) { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
  function body(h) { mountCard(); card.querySelector('#toe-body').innerHTML = h }
  function foot(h) { mountCard(); card.querySelector('#toe-foot').innerHTML = h }

  function showSpin(msg) {
    body('<div class="toe-loading"><div class="toe-spin"></div><span>' + esc(msg) + '</span></div>')
  }

  function showTheses(list, real, url, title, pageText) {
    if (!Array.isArray(list) || list.length === 0) { showErr('Не вдалося отримати опис'); return }
    _readerPageText = pageText || ''
    body('<div class="toe-list">' +
      list.map(t => '<div class="toe-row"><div class="toe-dot"></div><span>' + esc(t) + '</span></div>').join('') +
      '</div>')
    foot(real ? '<a href="https://toessence.net" target="_blank" style="color:#22c55e;text-decoration:none">toEssence.net</a> \u00B7 AI' : '<a href="https://toessence.net" target="_blank" style="color:#22c55e;text-decoration:none">toEssence.net</a>')
    // Показуємо кнопку читалки в хедері
    mountCard()
    const readBtn = card.querySelector('#toe-read-btn')
    const isYtUrl = url && url.includes('youtube.com/watch')
    if (readBtn) readBtn.style.display = (url && !isYtUrl) ? 'flex' : 'none'
    requestAnimationFrame(reposition)
  }

  function showLimit(url, label) {
    body(
      '<div class="toe-limit">' +
        '<div class="toe-limit-title">Ліміт фільтрів вичерпано</div>' +
        '<div class="toe-limit-sub">Скидання через 24 год</div>' +
        '<a class="toe-limit-btn" href="' + esc(url) + '" target="_blank">Придбати тариф</a>' +
        '<button class="toe-limit-sleep" id="toe-sleep-btn">Продовжити Free</button>' +
      '</div>'
    )
    foot('toEssence \u00B7 \u0456\u043D\u0444\u043E\u0433\u0456\u0433\u0456\u0454\u043D\u0430')
    requestAnimationFrame(reposition)
    // Сплячий режим — вимикаємо до місцевої опівночі (коли лічильник обнулиться)
    setTimeout(() => {
      const btn = card && card.querySelector('#toe-sleep-btn')
      if (btn) btn.addEventListener('click', e => {
        e.stopPropagation()
        const midnight = new Date()
        midnight.setHours(24, 0, 0, 0)  // найближча місцева північ
        chrome.storage.local.set({ enabled: false, limit_disabled_until: midnight.getTime() })
        enabled = false
        card && card.classList.remove('toe-visible')
      })
    }, 0)
  }

  function showErr(msg) { body('<div class="toe-error">' + esc(msg) + '</div>'); requestAnimationFrame(reposition) }

  // ── Іконка мови ──────────────────────────────────────────────
  function setLangBtn(lang, active) {
    mountCard()
    const btn = card.querySelector('#toe-lang')
    if (!btn) return
    if (lang) {
      btn.style.display = 'flex'
      btn.textContent = lang.toUpperCase().slice(0, 2)
      btn.title = active ? 'Переключити на мову інтерфейсу' : 'Читати мовою оригіналу'
      if (active) {
        btn.style.color = '#22c55e'
        btn.style.borderColor = 'rgba(34,197,94,.5)'
        btn.style.background = 'rgba(34,197,94,.1)'
      } else {
        btn.style.color = ''
        btn.style.borderColor = ''
        btn.style.background = ''
      }
    } else {
      btn.style.display = 'none'
    }
  }

  function toggleLang() {
    if (!currentUrl || !origLang) return
    showingOrig = !showingOrig
    setLangBtn(origLang, showingOrig)
    const langToUse = showingOrig ? origLang : LANG
    const cacheKey = 'news:' + currentUrl + ':' + langToUse
    if (cache.has(cacheKey)) {
      const c = cache.get(cacheKey)
      showTheses(c.theses, c.hadContent)
      return
    }
    showSpin('Перекладаю\u2026')
    api(
      {type: 'news', url:currentUrl, title:'', lang:langToUse},
      (partial) => { body('<div class="toe-list"><div class="toe-row"><div class="toe-dot"></div><span>' + esc(partial) + '▌</span></div></div>') },
      (finalText) => {
        if (!finalText) { showErr('Помилка'); return }
        const data = { theses: [finalText], hadContent: true }
        cache.set(cacheKey, data)
        showTheses(data.theses, data.hadContent)
      },
      (err) => showErr(err)
    )
  }

  function updateThemeBtn() {
    mountCard()
    const btn = card.querySelector('#toe-theme')
    if (!btn) return
    // Sun icon for dark mode, moon icon for light mode
    if (_lightTheme) {
      // показуємо місяць (переключити на темну)
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
    } else {
      // показуємо сонце (переключити на світлу)
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
    }
  }

  function getArticleText() {
    // Беремо текст напряму з body
    return (document.body.innerText || document.body.textContent || '')
      .replace(/\s{3,}/g, '\n\n').trim()
  }

  const readerCache = new Map()

  function _openReaderOverlay(markdown, url) {
    // Використовуємо той самий Shadow DOM підхід
    showReader('__cached__', url)
  }

  function showReader(pageText, url) {
    const cached = readerCache.get(url)

    const green = '#22c55e'
    const domain = (() => { try { return new URL(url).hostname } catch { return '' } })()

    // Shadow DOM — повна ізоляція від CSS сайту
    const host = document.createElement('div')
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646'
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })

    const getCSS = () => `
      * { box-sizing:border-box; margin:0; padding:0; }
      .wrap { position:fixed;inset:0;background:${_lightTheme ? '#f5f7fa' : '#121212'};font-family:Georgia,serif;display:flex;flex-direction:column; }
      .nav { flex-shrink:0;height:52px;background:${_lightTheme ? '#fff' : '#1a1a1a'};border-bottom:1px solid ${_lightTheme ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.08)'};display:flex;align-items:center;justify-content:space-between;padding:0 24px;z-index:10; }
      .logo { font-family:Georgia,serif;font-size:17px;font-weight:700;color:#9ba3b8; }
      .logo em { color:${green};font-style:normal; }
      .btns { display:flex;gap:8px;align-items:center; }
      a.link { font-family:monospace;font-size:10px;color:${green};text-decoration:none;padding:6px 12px;border:1px solid rgba(34,197,94,.3);border-radius:6px; }
      button.btn { background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.3);border-radius:6px;color:${green};width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0; }
      .content { flex-grow:1;overflow-y:auto;padding:32px 24px 80px; }
      .inner { max-width:700px;margin:0 auto; }
      #body { font-size:18px;line-height:1.9; }
      #body p { color:${_lightTheme ? '#1a1a1a' : '#ffffff'};margin:0 0 16px;line-height:1.85; }
      #body h1 { color:${_lightTheme ? '#111827' : '#ffffff'};font-size:24px;font-weight:800;margin:0 0 24px; }
      #body h2 { color:${_lightTheme ? '#111827' : '#ffffff'};font-size:18px;font-weight:700;margin:24px 0 10px; }
      #body h3 { color:${_lightTheme ? '#111827' : '#ffffff'};font-size:16px;font-weight:700;margin:16px 0 8px; }
      .spin-wrap { display:flex;align-items:center;gap:10px;color:${_lightTheme ? 'rgba(0,0,0,.4)' : 'rgba(255,255,255,.5)'};font-size:14px; }
      .spin { width:16px;height:16px;border-radius:50%;border:2px solid rgba(34,197,94,.2);border-top-color:${green};animation:sp .7s linear infinite; }
      @keyframes sp { to { transform:rotate(360deg); } }
    `

    const moonSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
    const sunSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
    const zoomSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><circle cx="10" cy="10" r="7"/><line x1="15" y1="15" x2="22" y2="22"/></svg>'
    const closeSVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'

    const render = () => {
      shadow.innerHTML = `
        <style>${getCSS()}</style>
        <div class="wrap">
          <div class="nav">
            <div class="logo"><a href="https://toessence.net" target="_blank" style="text-decoration:none;color:inherit">to<em>E</em>ssence</a></div>
            <div class="btns">
              <a href="${url}" target="_blank" class="link">${domain}</a>
              <button class="btn" id="r-theme">${_lightTheme ? moonSVG : sunSVG}</button>
              <button class="btn" id="r-zoom">${zoomSVG}</button>
              <button class="btn" id="r-close">${closeSVG}</button>
            </div>
          </div>
          <div class="content"><div class="inner"><div id="body"><div class="spin-wrap"><div class="spin"></div>Завантаження...</div></div></div></div>
        </div>`

      shadow.querySelector('#r-close').addEventListener('click', () => { host.remove(); document.body.style.overflow = '' })

      shadow.querySelector('#r-theme').addEventListener('click', () => {
        _lightTheme = !_lightTheme
        render()
        card && card.classList.toggle('toe-light', _lightTheme)
        updateThemeBtn()
        // Відновлюємо текст якщо вже завантажений
        const cached = readerCache.get(url)
        if (cached) shadow.querySelector('#body').innerHTML = renderMarkdownShadow(cached)
      })

      let zoomed = false
      shadow.querySelector('#r-zoom').addEventListener('click', () => {
        zoomed = !zoomed
        const b = shadow.querySelector('#body')
        if (b) b.style.fontSize = zoomed ? '22px' : '18px'
      })
    }

    render()
    document.body.style.overflow = 'hidden'

    // Якщо є кеш — показуємо одразу
    if (cached) {
      const el = shadow.querySelector('#body')
      if (el) el.innerHTML = renderMarkdownShadow(cached)
      return
    }

    document.addEventListener('keydown', function escFn(e) {
      if (e.key === 'Escape') { host.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', escFn) }
    })

    const loadAndRender = (text) => {
      let accumulated = ''
      api(
        { type: 'reader', rawText: text.slice(0, 20000), lang: LANG, url },
        (partial) => {
          accumulated = partial
          const el = shadow.querySelector('#body')
          if (el) el.innerHTML = renderMarkdownShadow(accumulated) + '<span style="opacity:.5">▌</span>'
        },
        (finalText) => {
          if (!finalText) { host.remove(); document.body.style.overflow = ''; showErr('Текст не знайдено'); return }
          readerCache.set(url, finalText)
          const el = shadow.querySelector('#body')
          if (el) el.innerHTML = renderMarkdownShadow(finalText)
        },
        (err) => { host.remove(); document.body.style.overflow = ''; showErr('Помилка: ' + err) }
      )
    }

    if (pageText && pageText.length > 200) {
      loadAndRender(pageText)
    } else {
      safeSend({ type: 'FETCH_URL', url }, r => {
        let text = ''
        if (r && r.html) {
          text = r.html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim()
            .slice(0, 30000)
        }
        loadAndRender(text.length > 200 ? text : pageText || '')
      })
    }
  }


  // Рендеримо markdown в HTML
  function renderMarkdown(md, fg, light) {
    const headColor = light ? '#111827' : '#ffffff'
    const textColor = light ? '#1a1a2e' : '#ffffff'
    return md.split('\n').map(line => {
      const t = line.trim()
      if (!t) return '<div style="height:16px"></div>'
      if (t.startsWith('# '))  return `<p style="font-size:24px;font-weight:800;color:${headColor} !important;margin:0 0 24px;line-height:1.35">${t.slice(2)}</p>`
      if (t.startsWith('## ')) return `<p style="font-size:18px;font-weight:700;color:${headColor} !important;margin:24px 0 10px;line-height:1.3">${t.slice(3)}</p>`
      if (t.startsWith('### ')) return `<p style="font-size:16px;font-weight:700;color:${headColor};margin:16px 0 8px">${t.slice(4)}</p>`
      const formatted = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      return `<p style="margin:0 0 16px;color:${textColor} !important;line-height:1.85">${formatted}</p>`
    }).join('')
  }

  function renderMarkdownShadow(md) {
    return md.split('\n').map(line => {
      const t = line.trim()
      if (!t) return '<div style="height:16px"></div>'
      if (t.startsWith('# '))  return `<h1>${t.slice(2)}</h1>`
      if (t.startsWith('## ')) return `<h2>${t.slice(3)}</h2>`
      if (t.startsWith('### ')) return `<h3>${t.slice(4)}</h3>`
      const f = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      return `<p>${f}</p>`
    }).join('')
  }

  function reposition() {
    const W = magOn ? 460 : 340, M = 10
    const H = card.offsetHeight
    let l = lastX + 16, t = lastY + 16
    if (l + W > window.innerWidth  - M) l = lastX - W - 16
    if (t + H > window.innerHeight - M) t = window.innerHeight - H - M
    if (l < M) l = M
    if (t < M) t = M
    card.style.left = l + 'px'
    card.style.top  = t + 'px'
  }

  function place(x, y) {
    lastX = x; lastY = y
    mountCard()
    card.classList.add('toe-visible')
    reposition()
  }

  function scheduleHide() {
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => card && card.classList.remove('toe-visible'), HIDE_MS)
  }

  function inView(x, y) { return x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight - 2 }

  // Миттєво ховаємо тултіп, коли браузер втратив фокус або вкладка стала неактивною
  function _hideOnBlur() {
    if (curEl) { curEl = null; clearTimeout(hoverTimer); stopBill() }
    clearTimeout(hideTimer)
    if (_currentAbort) { _currentAbort.abort(); _currentAbort = null }
    if (card) card.classList.remove('toe-visible')
  }
  window.addEventListener('blur', _hideOnBlur)
  document.addEventListener('visibilitychange', () => { if (document.hidden) _hideOnBlur() })

  function bill(key) {
    // Списання вбудовано в основний запит — нічого не робимо
    billed.add(key)
  }
  function stopBill() {}

  const BACKEND_URL = 'https://xstqpvvxiftgppxnzpzv.supabase.co/functions/v1/filter'

  // Тихий звіт: надсилає поточне число фільтрів на сервер у фоні (не блокує нічого).
  // Захист від спаму: не частіше ніж раз на 10 секунд.
  let _lastReport = 0
  function reportToServer() {
    const now = Date.now()
    if (now - _lastReport < 10000) return  // не частіше 10с
    _lastReport = now
    chrome.storage.local.get(['uuid', 'filters_today', 'first_filter_time'], s => {
      const uuid = s.uuid
      if (!uuid) return
      // Локальна дата користувача (для скидання за місцевою північчю)
      const d = new Date()
      const dayKey = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
      fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'report', uuid, dayKey, count: s.filters_today || 0 })
      }).catch(() => {})  // помилка звіту нічого не ламає
    })
  }

  let _currentAbort = null  // Скасовує попередній запит
  let _currentBillTimeout = null  // Таймер списання фільтру

  function api(payload, onChunk, onDone, onErr) {
    // Скасовуємо попередній запит і таймер списання
    if (_currentAbort) { _currentAbort.abort(); _currentAbort = null }
    if (_currentBillTimeout) { clearTimeout(_currentBillTimeout); _currentBillTimeout = null }
    const abortCtrl = new AbortController()
    _currentAbort = abortCtrl
    chrome.storage.local.get('uuid', async d => {
      const uuid = d.uuid || (() => {
        const id = crypto.randomUUID()
        chrome.storage.local.set({ uuid: id })
        return id
      })()
      try {
        const r = await fetch(BACKEND_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid, ...payload }),
          signal: abortCtrl.signal
        })
        if (r.status === 402) { onErr('LIMIT'); return }
        if (!r.ok) { onErr('server error ' + r.status); return }

        const ct = r.headers.get('content-type') || ''
        if (ct.includes('text/event-stream')) {
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
              const raw = line.slice(6).trim()
              if (raw === '[DONE]') {
                _currentAbort = null
                onDone(text.trim(), meta)
                return
              }
              try {
                const d = JSON.parse(raw)
                if (d.meta) { meta = d.meta }
                else if (d.chunk) { text += d.chunk; onChunk(text) }
              } catch { continue }
            }
          }
          // Fallback — зберігаємо meta якщо [DONE] не прийшов
          onDone(text.trim(), meta)
        } else {
          const data = await r.json()
          if (data.error === 'LIMIT_REACHED') { onErr('LIMIT'); return }
          const result = data.data || data
          if (typeof result === 'string') onDone(result, data.meta)
          else onDone(result?.theses?.[0] || '', data.meta)
        }
      } catch(e) { if (e.name === 'AbortError') return; onErr(e.message || 'connection error') }
    })
  }

  function handleMove(e, getEl, trigger) {
    if (!enabled || !inView(e.clientX, e.clientY)) return
    // Якщо поверх браузера інша програма/вікно/месенджер або вкладка неактивна — не реагуємо
    if (!document.hasFocus() || document.hidden) {
      if (curEl) { curEl = null; clearTimeout(hoverTimer); stopBill() }
      if (_currentAbort) { _currentAbort.abort(); _currentAbort = null }
      if (card) card.classList.remove('toe-visible')
      return
    }
    if (card && card.contains(e.target)) { clearTimeout(hideTimer); return }
    const el = getEl(e.target)
    if (!el) {
      if (curEl) { curEl = null; clearTimeout(hoverTimer); stopBill(); scheduleHide() }
      return
    }
    if (el === curEl) return
    // Той самий href (інший рядок тієї ж новини) — нічого не робимо.
    // Лише якщо ОБИДВА мають href (на YT картки не мають href — пропускаємо цю перевірку)
    try {
      if (curEl && el.href && curEl.href && el.href === curEl.href) { curEl = el; return }
    } catch (_) {}
    curEl = el; clearTimeout(hoverTimer); stopBill()
    // Новий заголовок — одразу ховаємо старе вікно й рвемо старий запит,
    // щоб не блимав попередній текст під час затримки наведення
    if (_currentAbort) { _currentAbort.abort(); _currentAbort = null }
    if (card) { card.classList.remove('toe-visible'); const b = card.querySelector('#toe-body'); if (b) b.innerHTML = '' }
    const x = e.clientX, y = e.clientY
    hoverTimer = setTimeout(() => trigger(el, x, y), HOVER_MS)
  }

  // ── YOUTUBE ──────────────────────────────────────────────────
  if (IS_YT) {
    const YT_SEL = 'ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer,ytd-rich-grid-media,ytd-reel-item-renderer,ytd-playlist-video-renderer'
    const YT_TITLE = '#video-title, a#video-title-link, yt-formatted-string#video-title, h3 a'

    function getYtEl(t) {
      // Спрацьовує ЛИШЕ коли курсор на тексті назви відео (не на превʼю)
      const titleEl = t.closest(YT_TITLE)
      if (!titleEl) return null
      return titleEl.closest(YT_SEL) || titleEl
    }

    async function ytTrigger(el, x, y) {
      const link = el.querySelector('a[href*="watch?v="]')
      if (!link) return
      let vid
      try { vid = new URL(link.href).searchParams.get('v') } catch { return }
      if (!vid) return

      const title = (el.querySelector('#video-title,h3 a,h3') || {innerText:''}).innerText.trim()
      const key = 'yt:' + vid
      currentUrl = 'https://www.youtube.com/watch?v=' + vid

      if (card) { const b = card.querySelector('#toe-body'); if (b) b.innerHTML = '' }
      showSpin('Аналізую відео\u2026'); place(x, y)

      if (cache.has(key)) {
        const c = cache.get(key)
        showTheses(c.theses, c.hadContent)
        bill(key)
        return
      }

      // YouTube списує 1 фільтр — рахуємо на першому шматку тексту
      let _ytCounted = false
      const ytCountOnce = () => {
        if (_ytCounted || billed.has(key)) return
        _ytCounted = true
        billed.add(key)
        chrome.storage.local.get(['filters_today','first_filter_time','plan'], s => {
          const now = Date.now()
          const isNewDay = !s.first_filter_time || (new Date(s.first_filter_time).toDateString() !== new Date(now).toDateString())
          const today = isNewDay ? 0 : (s.filters_today || 0)
          const plan = s.plan || 'free'
          const limits = { free:10, easy:50, pro:150, owner:500 }
          const limit = limits[plan] || 10
          chrome.storage.local.set({
            filters_today: Math.min(today + 1, limit),
            first_filter_time: isNewDay || today === 0 ? new Date().toISOString() : (s.first_filter_time || new Date().toISOString())
          }, () => reportToServer())
        })
      }

      // Перевірка ліміту ПЕРЕД запитом
      chrome.storage.local.get(['filters_today','first_filter_time','is_pro','plan'], s => {
        const now = Date.now()
        const isNewDay = !s.first_filter_time || (new Date(s.first_filter_time).toDateString() !== new Date(now).toDateString())
        const today = isNewDay ? 0 : (s.filters_today || 0)
        const isPro = s.is_pro || false
        const plan = s.plan || 'free'
        const limits = { free:10, easy:50, pro:150, owner:500 }
        const limit = limits[plan] || 10
        if (!isPro && today >= limit) { showLimit('https://toessence.net', ''); return }

        // Субтитри завантажує бекенд через Supadata
        api(
          {type: 'youtube', url: 'https://www.youtube.com/watch?v=' + vid, title, lang:LANG},
          (partial) => { ytCountOnce(); body('<div class="toe-list"><div class="toe-row"><div class="toe-dot"></div><span>' + esc(partial) + '▌</span></div></div>'); requestAnimationFrame(reposition) },
          (finalText) => {
            if (!finalText) { showErr('Некоректна відповідь сервера'); return }
            const data = { theses: [finalText], hadContent: true }
            cache.set(key, data)
            showTheses(data.theses, data.hadContent, 'https://www.youtube.com/watch?v=' + vid, title, '')
            bill(key)
          },
          (err) => { if (err === 'LIMIT') { showLimit('https://toessence.net', ''); return }; showErr(err) }
        )
      })
    }

    document.addEventListener('mousemove', e => handleMove(e, getYtEl, ytTrigger))
  }

  // ── NEWS ─────────────────────────────────────────────────────
  if (!IS_YT) {
    function isHeadline(a) {
      if (!a || a.tagName !== 'A' || !a.href) return false
      const txt = (a.innerText || '').trim()
      if (txt.length < 20 || txt.length > 300 || txt.split(/\s+/).length < 3) return false
      try { const u = new URL(a.href); if (u.hash && u.pathname === location.pathname) return false } catch { return false }
      return true
    }

    function getNewsEl(t) { const a = t.closest('a'); return isHeadline(a) ? a : null }

    function getPageText() {
      const selectors = [
        'article', '[role="main"]', '.article-body', '.post-content',
        '.entry-content', '.story-body', '.article__body', '.content-body',
        '.article-text', '.news-text', '.post-text', '.article-content',
        '.single-content', '.page-content', '.text-content', '.body-text',
        '[class*="article"]', '[class*="story"]', '[class*="content"]',
        '[itemprop="articleBody"]', '[class*="post-body"]', '[class*="news-body"]'
      ]
      ;['[class*="mgid"]','[class*="sponsor"]','[class*="recom"]','[class*="related"]',
        '[class*="promo"]','[id*="mgid"]','[data-widget]','[class*="widget"]',
        '[class*="inject"]','[class*="banner"]','[class*="advert"]',
        '[class*="social"]','[class*="share"]','[class*="comment"]',
        'aside','[class*="aside"]','nav','header','footer'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove())
      })
      for (const sel of selectors) {
        const el = document.querySelector(sel)
        if (el) {
          const paras = Array.from(el.querySelectorAll('p, h1, h2, h3, h4'))
            .map(p => p.innerText.trim())
            .filter(t => t.length > 20)
            .join('\n\n')
          if (paras.length > 200) return paras  // повний текст
        }
      }
      // Fallback — беремо найдовший блок тексту на сторінці
      const allDivs = Array.from(document.querySelectorAll('div'))
        .map(d => ({ el: d, text: d.innerText?.trim() || '' }))
        .filter(d => d.text.length > 300 && !d.el.querySelector('nav'))
        .sort((a, b) => b.text.length - a.text.length)
      
      if (allDivs.length) {
        const paras = Array.from(allDivs[0].el.querySelectorAll('p'))
          .map(p => p.innerText.trim())
          .filter(t => t.length > 30)
          .join('\n\n')
        if (paras.length > 100) return paras
        return allDivs[0].text
      }

      const paras = Array.from(document.querySelectorAll('p'))
        .map(p => p.innerText.trim())
        .filter(t => t.length > 50)
        .join('\n\n')
      return paras
    }

    // ⚡ Prefetch тексту при наведенні
    const prefetchCache = new Map()      // текст з DOM (та сама сторінка)
    const prefetchHtml = new Map()       // текст статті зі стрічки (інший сайт)
    let _prefetchingUrl = null           // яку статтю зараз тягнемо (лише одну)

    document.addEventListener('mouseover', e => {
      if (!enabled) return
      const a = e.target.closest('a')
      if (!isHeadline(a)) return
      try {
        const u = new URL(a.href)
        if (u.hostname === location.hostname && u.pathname === location.pathname) {
          // Стаття на цій самій сторінці — беремо текст із DOM
          if (!prefetchCache.has(a.href)) prefetchCache.set(a.href, getPageText())
        } else {
          // Стаття зі стрічки — тягнемо HTML у фоні (ЛИШЕ одну, поточну)
          if (!prefetchHtml.has(a.href) && _prefetchingUrl !== a.href) {
            _prefetchingUrl = a.href
            safeSend({ type: 'FETCH_URL', url: a.href }, r => {
              _prefetchingUrl = null
              if (r && r.html) {
                const tmp = document.createElement('div')
                tmp.innerHTML = r.html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
                const fetched = (tmp.innerText || '').replace(/\s{2,}/g, ' ').trim().slice(0, 3000)
                prefetchHtml.set(a.href, fetched.length > 100 ? fetched : '')
              } else {
                prefetchHtml.set(a.href, '')
              }
            })
          }
        }
      } catch (_) {}
    }, { passive: true })

    function newsTrigger(el, x, y) {
      const key = 'news:' + el.href + ':' + LANG
      let site = HOST; try { site = new URL(el.href).hostname } catch (_) {}

      if (currentUrl !== el.href) {
        currentUrl = el.href
        showingOrig = false
        origLang = null
        setLangBtn(null, false)
      }

      // Одразу ховаємо старий вміст, щоб не блимав попередній текст
      if (card) { const b = card.querySelector('#toe-body'); if (b) b.innerHTML = '' }
      showSpin('Аналізую статтю\u2026'); place(x, y)
      // Показуємо кнопку читалки одразу
      mountCard()
      const _rb = card.querySelector('#toe-read-btn')
      if (_rb) _rb.style.display = 'flex'

      if (cache.has(key)) {
        const c = cache.get(key)
        if (!c || !c.theses) { showErr('Помилка даних кешу'); return }
        if (c.origLang && c.origLang !== LANG.split('-')[0]) {
          origLang = c.origLang
          setLangBtn(origLang, false)
        }
        showTheses(c.theses, c.hadContent, el.href, el.innerText.trim()); bill(key); return
      }

      const title = el.innerText.trim()

      // Якщо на тій самій сторінці — беремо текст одразу
      let pageText = ''
      try {
        const linkUrl = new URL(el.href)
        const isCurrentPage = linkUrl.hostname === location.hostname && linkUrl.pathname === location.pathname
        if (isCurrentPage) pageText = prefetchCache.get(el.href) || getPageText()
      } catch (_) {}

      // Якщо текст є — одразу запит. Якщо немає — завантажуємо через браузер паралельно
      const doRequest = (pt) => {
        // +1 локально одразу
        chrome.storage.local.get(['filters_today','first_filter_time','is_pro','plan'], s => {
          const now = Date.now()
          const isNewDay = !s.first_filter_time || (new Date(s.first_filter_time).toDateString() !== new Date(now).toDateString())
          const today = isNewDay ? 0 : (s.filters_today || 0)
          const isPro = s.is_pro || false
          const plan = s.plan || 'free'
          const limits = { free:10, easy:50, pro:150, owner:500 }
          const limit = limits[plan] || 10

          if (!isPro && today >= limit) {
            showLimit('https://toessence.net', '')
            return
          }

          // Прапорець: чи вже порахували цей запит (рахуємо на першому шматку тексту)
          let _counted = false
          const countOnce = () => {
            if (_counted || billed.has(key)) return
            _counted = true
            billed.add(key)
            chrome.storage.local.set({
              filters_today: today + 1,
              first_filter_time: isNewDay || today === 0 ? new Date().toISOString() : (s.first_filter_time || new Date().toISOString())
            }, () => reportToServer())
          }

          api(
            { type: 'news', url: el.href, title, lang: LANG, pageText: pt },
            (partialText) => {
              countOnce()  // перший шматок тексту прийшов — рахуємо +1
              body('<div class="toe-list"><div class="toe-row"><div class="toe-dot"></div><span>' + esc(partialText) + '▌</span></div></div>')
              requestAnimationFrame(reposition)
            },
            (finalText, meta) => {
              if (!finalText) { showErr('Некоректна відповідь сервера'); return }
              // Синхронізуємо план з бекенду — тільки якщо бекенд повертає вищий план
              if (meta?.isPro !== undefined) {
                const planRank = { free:0, easy:1, pro:2, owner:3 }
                const currentRank = planRank[plan] || 0
                const metaRank = planRank[meta.plan] || 0
                if (metaRank > currentRank) chrome.storage.local.set({ is_pro: meta.isPro, plan: meta.plan })
              }
              const data = { theses: [finalText], hadContent: true }
              cache.set(key, data)
              showTheses(data.theses, data.hadContent, el.href, title, pt)
              bill(key)
            },
            (err) => {
              if (err === 'LIMIT') { showLimit('https://toessence.net', ''); return }
              showErr(err)
            }
          )
        })
      }

      // Запускаємо — одразу якщо є текст (з DOM або prefetch), або завантажуємо
      if (pageText.length > 100) {
        doRequest(pageText)
      } else if (prefetchHtml.has(el.href)) {
        // Текст статті вже завантажено наперед при наведенні — використовуємо одразу
        doRequest(prefetchHtml.get(el.href) || '')
      } else {
        safeSend({ type: 'FETCH_URL', url: el.href }, r => {
          if (r && r.html) {
            const tmp = document.createElement('div')
            tmp.innerHTML = r.html
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
            const fetched = (tmp.innerText || '').replace(/\s{2,}/g, ' ').trim().slice(0, 3000)
            doRequest(fetched.length > 100 ? fetched : '')
          } else {
            doRequest('')
          }
        })
      }
    }

  
  // ── READER ───────────────────────────────────────────────────

  document.addEventListener('mousemove', e => handleMove(e, getNewsEl, newsTrigger))
  }

  // ── MAGNIFIER ────────────────────────────────────────────────
  function toggleMag() {
    magOn = !magOn
    mountCard()
    const btn = card.querySelector('#toe-mag')
    if (magOn) {
      card.classList.add('toe-zoom')
      if (btn) { btn.style.color = '#22c55e'; btn.style.borderColor = 'rgba(34,197,94,.5)' }
    } else {
      card.classList.remove('toe-zoom')
      if (btn) { btn.style.color = ''; btn.style.borderColor = '' }
    }
    // Перераховуємо позицію щоб картка не виходила за межі екрану
    requestAnimationFrame(() => {
      const W = magOn ? 460 : 340, M = 10
      const H = card.offsetHeight
      let l = lastX + 16, t = lastY + 16
      if (l + W > window.innerWidth  - M) l = lastX - W - 16
      if (t + H > window.innerHeight - M) t = window.innerHeight - H - M
      if (l < M) l = M
      if (t < M) t = M
      card.style.left = l + 'px'
      card.style.top  = t + 'px'
    })
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && magOn) toggleMag() })

})()
