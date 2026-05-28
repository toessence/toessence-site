function updateStatus() {
  chrome.runtime.sendMessage({type:'GET_STATUS'}, s => {
    if (!s) return
    const plan = s.plan || 'free'
    const limits = { free:10, easy:50, pro:150, owner:500 }
    const limit = limits[plan] || 10
    const used = s.filtersToday || 0
    const pct = Math.min((used / limit) * 100, 100)

    document.getElementById('used').textContent = used
    document.getElementById('limit').textContent = limit
    document.getElementById('fill').style.width = pct + '%'
    document.getElementById('fill').style.background = pct >= 100 ? '#f87171' : '#22c55e'

    const badge = document.getElementById('planBadge')
    badge.textContent = plan.toUpperCase()
    badge.className = 'plan-badge ' + (['free','easy','pro'].includes(plan) ? plan : 'pro')

    if (s.isPro) {
      const block = document.getElementById('upgradeBlock')
      if (block) block.style.display = 'none'
    }

    if (!s.enabled) document.getElementById('tog').checked = false
  })
}

// Оновлюємо при відкритті
updateStatus()

// Оновлюємо при кожній зміні storage
chrome.storage.onChanged.addListener(() => updateStatus())

// Countdown до місцевої опівночі
function updateCountdown() {
  const note = document.getElementById('note')
  if (!note) return
  const now = new Date()
  const midnight = new Date(now)
  midnight.setHours(24, 0, 0, 0)
  const diff = midnight.getTime() - now.getTime()
  const h = Math.floor(diff / 3600000)
  const m = Math.floor((diff % 3600000) / 60000)
  note.textContent = `FILTERS · скидання через ${h}г ${m}хв`
}

updateCountdown()
setInterval(updateCountdown, 60000)

document.getElementById('tog').addEventListener('change', e => {
  chrome.runtime.sendMessage({type:'SET_ENABLED', value: e.target.checked})
})
