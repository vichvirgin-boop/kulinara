import React, { useState, useRef, useCallback, useEffect } from 'react'

// ─── localStorage ──────────────────────────────────────────────────────────────
const STORAGE_KEY = 'kulinara-db'

function loadDB() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : { recipes: [], libraryItems: [] }
  } catch {
    return { recipes: [], libraryItems: [] }
  }
}

function saveDB(db) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(db)) }
  catch (e) { console.error('Storage error', e) }
}

// ─── API — proxied through Netlify Function ────────────────────────────────────
const API_URL = '/api/claude'
const MODEL   = 'claude-sonnet-4-6'

async function callProxy(payload) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1000, ...payload }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

async function callClaude(messages, system) {
  const d = await callProxy({ system, messages })
  return d.content?.map((b) => b.text || '').join('') || ''
}

const EXTRACT_SYSTEM = `You are a precise recipe extraction assistant. Extract ALL recipes from the provided content.
Return ONLY valid JSON with no markdown fences, no preamble, no trailing text.
Schema: {"recipes":[{"title":"string","ingredients":["string"],"steps":["string"],"servings":"string","time":"string","notes":"string"}]}
Rules:
- ingredients: one item per string, include quantities (e.g. "200g flour")
- steps: one clear action per string, no numbering
- time: total time as string (e.g. "45 min") or ""
- servings: e.g. "4 порции" or ""
- notes: any tips/notes or ""
- If nothing found: {"recipes":[]}`

async function extractFromImage(base64, mediaType) {
  const d = await callProxy({
    max_tokens: 2000,
    system: EXTRACT_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: 'Extract all recipes from this image. Look carefully for recipe titles, ingredient lists, and cooking instructions.' },
      ],
    }],
  })
  const text = d.content?.map((b) => b.text || '').join('') || '{}'
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()) } catch { return { recipes: [] } }
}

async function extractFromPDF(base64) {
  const d = await callProxy({
    max_tokens: 2000,
    system: EXTRACT_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'Extract all recipes from this document. Look carefully through all pages.' },
      ],
    }],
  })
  const text = d.content?.map((b) => b.text || '').join('') || '{}'
  try { return JSON.parse(text.replace(/```json|```/g, '').trim()) } catch { return { recipes: [] } }
}

async function findRecipesByIngredients(ingredients, recipes) {
  if (!recipes.length) return 'У вас пока нет сохранённых рецептов. Загрузите фото или PDF в Библиотеку.'
  const list = recipes.map((r, i) => `${i + 1}. ${r.title}: ${r.ingredients?.join(', ')}`).join('\n')
  return callClaude(
    [{ role: 'user', content: `У меня дома есть: ${ingredients}\n\nМои рецепты:\n${list}\n\nКакие рецепты я могу приготовить? Что можно сделать прямо сейчас, а чего не хватает для остальных?` }],
    'Ты помощник повара. Отвечай по-русски, конкретно и дружелюбно. Будь практичным.',
  )
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result.split(',')[1])
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

function fileToDataURL(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result)
    r.onerror = rej
    r.readAsDataURL(file)
  })
}

const uid   = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`
const today = () => new Date().toLocaleDateString('ru-RU')

function makeFileJob(file, thumb) {
  return {
    id: uid(), file, name: file.name,
    type: file.type === 'application/pdf' ? 'pdf' : 'img',
    thumb, status: 'pending', progress: 0, recipes: [], error: null,
  }
}

// ─── Icons ─────────────────────────────────────────────────────────────────────
const Ico = {
  Home:     () => <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
  Book:     () => <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>,
  Grid:     () => <svg width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  Plus:     () => <svg width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Upload:   () => <svg width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0018 9h-1.26A8 8 0 103 16.3"/></svg>,
  Star:     () => <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>,
  Trash:    () => <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6M9 6V4h6v2"/></svg>,
  Check:    () => <svg width="12" height="12" fill="none" stroke="#fff" strokeWidth="3" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>,
  ChevDown: () => <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>,
  Scan:     () => <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 7V5a2 2 0 012-2h2M17 3h2a2 2 0 012 2v2M21 17v2a2 2 0 01-2 2h-2M7 21H5a2 2 0 01-2-2v-2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>,
  Save:     () => <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>,
}

// ─── ReviewRecipeCard ──────────────────────────────────────────────────────────
function ReviewRecipeCard({ recipe, selected, onToggle, onChange }) {
  const [open, setOpen] = useState(true)
  const r = recipe

  const set     = (field, val) => onChange({ ...r, [field]: val })
  const setIng  = (i, val)    => { const a = [...r.ingredients]; a[i] = val; set('ingredients', a) }
  const addIng  = ()          => set('ingredients', [...r.ingredients, ''])
  const remIng  = (i)         => set('ingredients', r.ingredients.filter((_, j) => j !== i))
  const setStep = (i, val)    => { const a = [...r.steps]; a[i] = val; set('steps', a) }
  const addStep = ()          => set('steps', [...r.steps, ''])
  const remStep = (i)         => set('steps', r.steps.filter((_, j) => j !== i))

  return (
    <div className="review-recipe">
      <div className="review-recipe-head" onClick={() => setOpen((o) => !o)}>
        <div
          className={`review-check ${selected ? 'checked' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggle() }}
        >
          {selected && <Ico.Check />}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.title || 'Без названия'}
          </div>
          <div style={{ fontSize: 11, color: '#8B8FA8', marginTop: 2 }}>
            {r.ingredients?.length || 0} ингр. · {r.steps?.length || 0} шагов{r.time ? ` · ${r.time}` : ''}
          </div>
        </div>
        <span className={`expand-arrow ${open ? 'open' : ''}`}><Ico.ChevDown /></span>
      </div>

      {open && (
        <div className="review-body">
          <div className="review-label">Название</div>
          <input className="input mb8" style={{ fontSize: 13, padding: '8px 12px' }}
            value={r.title} onChange={(e) => set('title', e.target.value)} placeholder="Название рецепта" />

          <div className="row2 mb8">
            <div style={{ flex: 1 }}>
              <div className="review-label">Время</div>
              <input className="input" style={{ fontSize: 13, padding: '8px 12px' }}
                value={r.time} onChange={(e) => set('time', e.target.value)} placeholder="45 мин" />
            </div>
            <div style={{ flex: 1 }}>
              <div className="review-label">Порции</div>
              <input className="input" style={{ fontSize: 13, padding: '8px 12px' }}
                value={r.servings} onChange={(e) => set('servings', e.target.value)} placeholder="4" />
            </div>
          </div>

          <div className="review-label">Ингредиенты</div>
          {r.ingredients?.map((ing, i) => (
            <div key={i} className="row2" style={{ marginBottom: 4 }}>
              <input className="input" style={{ fontSize: 12, padding: '6px 10px' }}
                value={ing} onChange={(e) => setIng(i, e.target.value)} placeholder={`Ингредиент ${i + 1}`} />
              <button className="btn ghost xs" onClick={() => remIng(i)}><Ico.Trash /></button>
            </div>
          ))}
          <button className="btn ghost xs" style={{ marginBottom: 8 }} onClick={addIng}><Ico.Plus /> Добавить</button>

          <div className="review-label">Шаги</div>
          {r.steps?.map((step, i) => (
            <div key={i} className="row2" style={{ marginBottom: 4, alignItems: 'flex-start' }}>
              <div style={{ minWidth: 20, height: 20, borderRadius: '50%', background: '#FF6B3518', color: '#FF6B35', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, marginTop: 8, flexShrink: 0 }}>{i + 1}</div>
              <textarea className="input" style={{ fontSize: 12, padding: '6px 10px', minHeight: 52 }}
                value={step} onChange={(e) => setStep(i, e.target.value)} placeholder={`Шаг ${i + 1}`} />
              <button className="btn ghost xs" onClick={() => remStep(i)} style={{ marginTop: 4 }}><Ico.Trash /></button>
            </div>
          ))}
          <button className="btn ghost xs" style={{ marginBottom: 4 }} onClick={addStep}><Ico.Plus /> Добавить шаг</button>

          {r.notes !== undefined && (
            <>
              <div className="review-label">Заметки</div>
              <textarea className="input" style={{ fontSize: 12, padding: '6px 10px' }}
                value={r.notes} onChange={(e) => set('notes', e.target.value)} />
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ─── FileJobRow ────────────────────────────────────────────────────────────────
function FileJobRow({ job }) {
  const statusText = {
    pending:  'В очереди…',
    scanning: 'AI читает и распознаёт рецепты…',
    done:     job.recipes.length > 0 ? `Найдено рецептов: ${job.recipes.length}` : 'Рецепты не найдены',
    error:    job.error || 'Ошибка обработки',
  }[job.status]

  const fillClass = job.status === 'error' ? 'danger'
    : job.status === 'done' && job.recipes.length > 0 ? 'green' : ''

  return (
    <div className={`pipe-file ${job.status === 'done' ? 'done' : ''} ${job.status === 'error' ? 'error' : ''}`}>
      <div className="pipe-row">
        <div className="pipe-icon" style={{ background: job.type === 'pdf' ? '#2D1F40' : '#1A2E3B' }}>
          {job.thumb
            ? <img src={job.thumb} style={{ width: '100%', height: '100%', objectFit: 'cover' }} alt="" />
            : <span>{job.type === 'pdf' ? '📄' : '🖼'}</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pipe-name">{job.name}</div>
          <div className="pipe-status">{statusText}</div>
        </div>
        {job.status === 'scanning' && <div className="spin sm" />}
        {job.status === 'done' && job.recipes.length > 0  && <span className="badge ok">✓ {job.recipes.length}</span>}
        {job.status === 'done' && job.recipes.length === 0 && <span className="badge warn">0</span>}
        {job.status === 'error' && <span className="badge" style={{ background: '#FF445518', color: '#FF4455' }}>!</span>}
      </div>
      <div className="pipe-bar">
        <div className={`pipe-fill ${fillClass}`} style={{ width: `${job.progress}%` }} />
      </div>
    </div>
  )
}

// ─── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('home')
  const [db,  setDB]  = useState(null)

  // Home
  const [ingredients, setIngredients] = useState('')
  const [aiAnswer,    setAiAnswer]    = useState('')
  const [aiLoading,   setAiLoading]   = useState(false)
  const [aiError,     setAiError]     = useState('')

  // Recipes
  const [selectedRecipe, setSelectedRecipe] = useState(null)
  const [showAddModal,   setShowAddModal]   = useState(false)
  const [newR, setNewR] = useState({ title: '', ingredients: '', steps: '', time: '', servings: '' })

  // Library import flow
  const [importStage,  setImportStage]  = useState('idle') // idle | processing | reviewing | saved
  const [jobs,         setJobs]         = useState([])
  const [reviewItems,  setReviewItems]  = useState([])
  const [dragOver,     setDragOver]     = useState(false)
  const [savedCount,   setSavedCount]   = useState(0)
  const fileRef = useRef()

  useEffect(() => { setDB(loadDB()) }, [])

  const updateDB = useCallback((next) => { setDB(next); saveDB(next) }, [])

  const patchJob = useCallback((id, patch) => {
    setJobs((prev) => prev.map((j) => j.id === id ? { ...j, ...patch } : j))
  }, [])

  // ── File import ──────────────────────────────────────────────────────────────
  const handleFiles = useCallback(async (files) => {
    if (!files?.length || importStage === 'processing') return
    const arr = Array.from(files).filter(
      (f) => f.type.startsWith('image/') || f.type === 'application/pdf'
    )
    if (!arr.length) return

    const jobList = await Promise.all(arr.map(async (f) => {
      const thumb = f.type.startsWith('image/') ? await fileToDataURL(f) : null
      return makeFileJob(f, thumb)
    }))

    setJobs(jobList)
    setImportStage('processing')
    setReviewItems([])

    const allReview = []

    for (const job of jobList) {
      patchJob(job.id, { status: 'scanning', progress: 30 })
      try {
        const base64 = await fileToBase64(job.file)
        patchJob(job.id, { progress: 60 })

        const extracted = job.type === 'pdf'
          ? await extractFromPDF(base64)
          : await extractFromImage(base64, job.file.type)

        const recipes = (extracted.recipes || []).map((r) => ({
          id:          uid(),
          title:       r.title || '',
          ingredients: Array.isArray(r.ingredients) ? r.ingredients : [],
          steps:       Array.isArray(r.steps) ? r.steps : [],
          time:        r.time || '',
          servings:    r.servings || '',
          notes:       r.notes || '',
          source:      job.name,
          addedAt:     today(),
        }))

        patchJob(job.id, { status: 'done', progress: 100, recipes })

        if (recipes.length > 0) {
          allReview.push({
            jobId: job.id, jobName: job.name,
            jobType: job.type, thumb: job.thumb,
            recipes, selected: recipes.map((r) => r.id),
          })
        }
      } catch (e) {
        patchJob(job.id, { status: 'error', progress: 100, error: e.message || String(e) })
      }
    }

    await new Promise((r) => setTimeout(r, 600))
    setReviewItems(allReview)
    setImportStage('reviewing')
  }, [importStage, patchJob])

  const toggleRecipe = (jobId, recipeId) => {
    setReviewItems((prev) => prev.map((ri) => ri.jobId !== jobId ? ri : {
      ...ri,
      selected: ri.selected.includes(recipeId)
        ? ri.selected.filter((id) => id !== recipeId)
        : [...ri.selected, recipeId],
    }))
  }

  const updateReviewRecipe = (jobId, recipeId, updated) => {
    setReviewItems((prev) => prev.map((ri) => ri.jobId !== jobId ? ri : {
      ...ri,
      recipes: ri.recipes.map((r) => r.id === recipeId ? updated : r),
    }))
  }

  const saveSelected = () => {
    const toSave = reviewItems.flatMap((ri) =>
      ri.recipes.filter((r) => ri.selected.includes(r.id))
    )
    const libItems = jobs.map((j) => ({
      id: uid(), name: j.name, type: j.type, thumb: j.thumb,
      recipesFound:    j.recipes.length,
      recipesImported: reviewItems.find((ri) => ri.jobId === j.id)?.selected.length || 0,
      addedAt: today(),
    }))
    updateDB({
      recipes:      [...(db?.recipes || []),      ...toSave],
      libraryItems: [...(db?.libraryItems || []), ...libItems],
    })
    setSavedCount(toSave.length)
    setImportStage('saved')
  }

  const resetImport = () => {
    setImportStage('idle'); setJobs([]); setReviewItems([]); setSavedCount(0)
    if (fileRef.current) fileRef.current.value = ''
  }

  // ── Manual recipe ────────────────────────────────────────────────────────────
  const handleAddRecipe = () => {
    if (!newR.title.trim()) return
    const r = {
      id: uid(), title: newR.title,
      ingredients: newR.ingredients.split('\n').filter(Boolean),
      steps:       newR.steps.split('\n').filter(Boolean),
      time: newR.time, servings: newR.servings,
      source: 'manual', addedAt: today(),
    }
    updateDB({ ...db, recipes: [...(db?.recipes || []), r] })
    setNewR({ title: '', ingredients: '', steps: '', time: '', servings: '' })
    setShowAddModal(false)
  }

  const deleteRecipe  = (id) => { updateDB({ ...db, recipes:      db.recipes.filter((r) => r.id !== id) }); setSelectedRecipe(null) }
  const deleteLibItem = (id) => { updateDB({ ...db, libraryItems: db.libraryItems.filter((l) => l.id !== id) }) }

  // ── AI ingredient search ─────────────────────────────────────────────────────
  const handleSearch = async () => {
    if (!ingredients.trim() || aiLoading) return
    setAiLoading(true); setAiAnswer(''); setAiError('')
    try {
      const ans = await findRecipesByIngredients(ingredients, db?.recipes || [])
      setAiAnswer(ans)
    } catch (e) {
      setAiError(e.message || 'Ошибка подключения к AI.')
    }
    setAiLoading(false)
  }

  // ── Render ───────────────────────────────────────────────────────────────────
  if (!db) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>
      <div className="spin" style={{ width: 28, height: 28 }} />
    </div>
  )

  const recipes       = db.recipes      || []
  const libraryItems  = db.libraryItems || []
  const totalFound    = jobs.reduce((s, j) => s + j.recipes.length, 0)
  const pendingReview = reviewItems.reduce((s, ri) => s + ri.selected.length, 0)

  return (
    <div className="app">

      {/* ── Recipe detail overlay ── */}
      {selectedRecipe && (
        <div className="detail-overlay">
          <div className="detail-topbar">
            <button className="btn ghost sm" onClick={() => setSelectedRecipe(null)}>← Назад</button>
            <button className="btn danger sm" onClick={() => deleteRecipe(selectedRecipe.id)}>
              <Ico.Trash /> Удалить
            </button>
          </div>
          <div style={{ padding: '16px 16px 80px' }}>
            {selectedRecipe.source && selectedRecipe.source !== 'manual' && (
              <div style={{ marginBottom: 8, display: 'flex', gap: 6 }}>
                <span className="badge ai">AI</span>
                <span style={{ fontSize: 11, color: '#8B8FA8', alignSelf: 'center' }}>из {selectedRecipe.source}</span>
              </div>
            )}
            <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: 24, fontWeight: 800, marginBottom: 6 }}>
              {selectedRecipe.title}
            </h1>
            <div className="card-meta" style={{ marginBottom: 20 }}>
              {selectedRecipe.time     && <span>⏱ {selectedRecipe.time}</span>}
              {selectedRecipe.servings && <span>🍽 {selectedRecipe.servings}</span>}
              {selectedRecipe.addedAt  && <span>📅 {selectedRecipe.addedAt}</span>}
            </div>
            {selectedRecipe.ingredients?.length > 0 && (
              <>
                <div className="sec-label">Ингредиенты</div>
                <div style={{ marginBottom: 20 }}>
                  {selectedRecipe.ingredients.map((ing, i) => <span key={i} className="pill">{ing}</span>)}
                </div>
              </>
            )}
            {selectedRecipe.steps?.length > 0 && (
              <>
                <div className="sec-label">Приготовление</div>
                {selectedRecipe.steps.map((s, i) => (
                  <div key={i} className="step-row">
                    <div className="step-num">{i + 1}</div>
                    <p style={{ fontSize: 14, lineHeight: 1.65, paddingTop: 3 }}>{s}</p>
                  </div>
                ))}
              </>
            )}
            {selectedRecipe.notes && (
              <>
                <div className="sec-label">Заметки</div>
                <p style={{ fontSize: 13, color: '#8B8FA8', lineHeight: 1.55 }}>{selectedRecipe.notes}</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Add recipe modal ── */}
      {showAddModal && (
        <div className="modal-bg" onClick={() => setShowAddModal(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Новый рецепт</div>
            <input className="input mb8" placeholder="Название"
              value={newR.title} onChange={(e) => setNewR({ ...newR, title: e.target.value })} />
            <div className="row2 mb8">
              <input className="input" placeholder="Время (45 мин)"
                value={newR.time}     onChange={(e) => setNewR({ ...newR, time: e.target.value })} />
              <input className="input" placeholder="Порции"
                value={newR.servings} onChange={(e) => setNewR({ ...newR, servings: e.target.value })} />
            </div>
            <textarea className="input mb8"
              placeholder={'Ингредиенты (по одному на строку)\n200г муки\n2 яйца'}
              value={newR.ingredients} onChange={(e) => setNewR({ ...newR, ingredients: e.target.value })} />
            <textarea className="input mb16"
              placeholder={'Шаги (по одному на строку)\nСмешать муку с яйцами\nВыпекать 30 минут'}
              value={newR.steps} onChange={(e) => setNewR({ ...newR, steps: e.target.value })} />
            <div className="row2">
              <button className="btn ghost full" onClick={() => setShowAddModal(false)}>Отмена</button>
              <button className="btn full" onClick={handleAddRecipe} disabled={!newR.title.trim()}>Сохранить</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Header ── */}
      <div className="header" style={{ paddingBottom: 14 }}>
        <div className="eyebrow">
          {tab === 'home' ? 'что приготовить?' : tab === 'recipes' ? 'все рецепты' : 'моя библиотека'}
        </div>
        <div className="page-title">
          {tab === 'home'    && <><span>Кулина</span>ра</>}
          {tab === 'recipes' && <>Рецепты</>}
          {tab === 'library' && <>Библиотека</>}
        </div>
      </div>

      {/* ── Scroll area ── */}
      <div className="scroll">

        {/* ═══ HOME ═══ */}
        {tab === 'home' && (
          <>
            <div className="sec-label">Что есть дома?</div>
            <div className="card" style={{ marginBottom: 10 }}>
              <p style={{ fontSize: 13, color: '#8B8FA8', marginBottom: 12, lineHeight: 1.5 }}>
                Напишите ингредиенты через запятую — AI подберёт рецепты из вашей базы.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <input className="input" placeholder="яйца, картошка, сыр…"
                  value={ingredients}
                  onChange={(e) => setIngredients(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()} />
                <button className="btn" onClick={handleSearch} disabled={aiLoading || !ingredients.trim()}>
                  {aiLoading ? <div className="spin sm" style={{ borderTopColor: '#fff' }} /> : <Ico.Star />}
                </button>
              </div>
            </div>

            {aiError && (
              <div style={{ background: '#FF445518', border: '1px solid #FF445540', borderRadius: 12, padding: '12px 14px', fontSize: 13, color: '#FF4455', marginBottom: 12 }}>
                ⚠ {aiError}
              </div>
            )}

            {aiAnswer && (
              <div className="ai-bubble">
                <div className="ai-label"><Ico.Star /> AI-подбор</div>
                {aiAnswer}
              </div>
            )}

            {recipes.length > 0 && (
              <>
                <div className="sec-label">Последние рецепты</div>
                {recipes.slice(-3).reverse().map((r) => (
                  <div key={r.id} className="card clickable" onClick={() => setSelectedRecipe(r)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div className="card-title">{r.title}</div>
                      {r.source !== 'manual' && <span className="badge ai">AI</span>}
                    </div>
                    <div className="card-meta">
                      {r.time     && <span>⏱ {r.time}</span>}
                      {r.servings && <span>🍽 {r.servings}</span>}
                      <span>{r.ingredients?.length || 0} ингр.</span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {recipes.length === 0 && !aiAnswer && !aiError && (
              <div className="empty">
                <div className="empty-emoji">🍳</div>
                <h3>Пока пусто</h3>
                <p>Добавьте рецепты вручную или загрузите фото страниц и PDF в Библиотеку — AI распознает их автоматически.</p>
              </div>
            )}
          </>
        )}

        {/* ═══ RECIPES ═══ */}
        {tab === 'recipes' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="sec-label">{recipes.length} рецептов</div>
              <button className="btn sm" onClick={() => setShowAddModal(true)}><Ico.Plus /> Добавить</button>
            </div>

            {recipes.length === 0 ? (
              <div className="empty">
                <div className="empty-emoji">📖</div>
                <h3>Нет рецептов</h3>
                <p>Добавьте рецепт вручную или загрузите фото кулинарной книги в Библиотеку.</p>
                <button className="btn" style={{ margin: '16px auto 0', display: 'flex' }} onClick={() => setShowAddModal(true)}>
                  <Ico.Plus /> Добавить рецепт
                </button>
              </div>
            ) : recipes.map((r) => (
              <div key={r.id} className="card clickable" onClick={() => setSelectedRecipe(r)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div className="card-title">{r.title}</div>
                  {r.source !== 'manual' && <span className="badge ai">AI</span>}
                </div>
                <div className="card-meta">
                  {r.time     && <span>⏱ {r.time}</span>}
                  {r.servings && <span>🍽 {r.servings}</span>}
                  {r.ingredients?.length > 0 && <span>{r.ingredients.length} ингр.</span>}
                </div>
                <div style={{ marginTop: 6 }}>
                  {r.ingredients?.slice(0, 5).map((ing, i) => <span key={i} className="pill">{ing}</span>)}
                  {r.ingredients?.length > 5 && (
                    <span className="pill" style={{ color: '#8B8FA8' }}>+{r.ingredients.length - 5}</span>
                  )}
                </div>
              </div>
            ))}
          </>
        )}

        {/* ═══ LIBRARY ═══ */}
        {tab === 'library' && (
          <>
            {/* IDLE */}
            {importStage === 'idle' && (
              <>
                <div className="sec-label">Загрузить материалы</div>
                <input ref={fileRef} type="file" accept="image/*,.pdf" multiple style={{ display: 'none' }}
                  onChange={(e) => handleFiles(e.target.files)} />
                <div
                  className={`drop-zone ${dragOver ? 'over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
                  onClick={() => fileRef.current?.click()}
                >
                  <Ico.Upload />
                  <p><strong>Фото страниц или PDF</strong></p>
                  <p>Перетащите файлы или нажмите для выбора.<br />AI распознает текст и найдёт все рецепты.</p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                    <span className="badge img">ФОТО</span>
                    <span className="badge pdf">PDF</span>
                  </div>
                </div>
              </>
            )}

            {/* PROCESSING */}
            {importStage === 'processing' && (
              <>
                <div className="sec-label">Сканирование файлов</div>
                <div className="pipeline">
                  {jobs.map((j) => <FileJobRow key={j.id} job={j} />)}
                </div>
                <p style={{ fontSize: 12, color: '#8B8FA8', textAlign: 'center', marginTop: 10 }}>
                  AI анализирует содержимое…
                </p>
              </>
            )}

            {/* REVIEWING */}
            {importStage === 'reviewing' && (
              <>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '16px 0 12px' }}>
                  {jobs.map((j) => (
                    <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#1A1D27', border: '1px solid #2E3248', borderRadius: 10, padding: '6px 10px' }}>
                      {j.thumb
                        ? <img src={j.thumb} style={{ width: 24, height: 24, borderRadius: 4, objectFit: 'cover' }} alt="" />
                        : <span style={{ fontSize: 14 }}>📄</span>}
                      <span style={{ fontSize: 12, color: '#8B8FA8', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.name}</span>
                      <span className={`badge ${j.recipes.length > 0 ? 'ok' : 'warn'}`}>{j.recipes.length}</span>
                    </div>
                  ))}
                </div>

                {totalFound === 0 ? (
                  <>
                    <div className="notice warn">⚠ Рецепты не найдены ни в одном файле</div>
                    <p style={{ fontSize: 13, color: '#8B8FA8', marginBottom: 16, lineHeight: 1.5 }}>
                      Попробуйте загрузить более чёткие фото или убедитесь, что PDF содержит текст.
                    </p>
                    <button className="btn ghost full" onClick={resetImport}>← Загрузить другие файлы</button>
                  </>
                ) : (
                  <>
                    <div className="notice">
                      <Ico.Scan /> Найдено {totalFound} рецептов. Проверьте и выберите для сохранения.
                    </div>
                    {reviewItems.map((ri) => (
                      <div key={ri.jobId} className="review-panel">
                        <div className="review-header">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            {ri.thumb
                              ? <img src={ri.thumb} style={{ width: 28, height: 28, borderRadius: 6, objectFit: 'cover' }} alt="" />
                              : <span style={{ fontSize: 16 }}>📄</span>}
                            <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ri.jobName}</span>
                          </div>
                          <span className="badge ok">{ri.selected.length}/{ri.recipes.length}</span>
                        </div>
                        {ri.recipes.map((r) => (
                          <ReviewRecipeCard
                            key={r.id} recipe={r}
                            selected={ri.selected.includes(r.id)}
                            onToggle={() => toggleRecipe(ri.jobId, r.id)}
                            onChange={(upd) => updateReviewRecipe(ri.jobId, r.id, upd)}
                          />
                        ))}
                      </div>
                    ))}
                    <div style={{ position: 'sticky', bottom: 80, display: 'flex', gap: 8, paddingBottom: 4 }}>
                      <button className="btn ghost" onClick={resetImport}>← Отмена</button>
                      <button className="btn green-btn full" onClick={saveSelected} disabled={pendingReview === 0}>
                        <Ico.Save /> Сохранить {pendingReview > 0 ? `${pendingReview} рец.` : ''}
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {/* SAVED */}
            {importStage === 'saved' && (
              <>
                <div style={{ textAlign: 'center', padding: '32px 0 24px' }}>
                  <div style={{ fontSize: 52, marginBottom: 12 }}>🎉</div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 22, fontWeight: 800, marginBottom: 6 }}>Сохранено!</div>
                  <p style={{ fontSize: 14, color: '#8B8FA8' }}>
                    {savedCount} {savedCount === 1 ? 'рецепт добавлен' : 'рецептов добавлено'} в базу
                  </p>
                </div>
                <div className="row2" style={{ marginBottom: 20 }}>
                  <button className="btn ghost full" onClick={resetImport}><Ico.Upload /> Загрузить ещё</button>
                  <button className="btn full" onClick={() => setTab('recipes')}><Ico.Book /> Мои рецепты</button>
                </div>
              </>
            )}

            {/* Library list — always visible */}
            {libraryItems.length > 0 && (
              <>
                <div className="divider" />
                <div className="sec-label">Загруженные материалы · {libraryItems.length}</div>
                {libraryItems.map((item) => (
                  <div key={item.id} className="card">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      {item.thumb
                        ? <img src={item.thumb} className="lib-thumb" alt="" />
                        : <div className="lib-pdf-icon">📄</div>}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', gap: 5, marginBottom: 4 }}>
                          <span className={`badge ${item.type}`}>{item.type.toUpperCase()}</span>
                          {item.recipesImported > 0 && (
                            <span className="badge ok">+{item.recipesImported} рец.</span>
                          )}
                        </div>
                        <div style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.name}
                        </div>
                        <div style={{ fontSize: 11, color: '#8B8FA8' }}>{item.addedAt}</div>
                      </div>
                      <button className="btn ghost sm" onClick={() => deleteLibItem(item.id)}><Ico.Trash /></button>
                    </div>
                  </div>
                ))}
              </>
            )}

            {libraryItems.length === 0 && importStage === 'idle' && (
              <div className="empty" style={{ paddingTop: 28 }}>
                <div className="empty-emoji">📚</div>
                <h3>Библиотека пуста</h3>
                <p>Загрузите фото страниц кулинарной книги или PDF — AI сам найдёт и сохранит рецепты.</p>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Tab bar ── */}
      <div className="tab-bar">
        {[
          { id: 'home',    label: 'Главная',    icon: <Ico.Home /> },
          { id: 'recipes', label: 'Рецепты',    icon: <Ico.Book /> },
          { id: 'library', label: 'Библиотека', icon: <Ico.Grid /> },
        ].map((t) => (
          <button key={t.id} className={`tab-btn ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <div className="tab-btn-inner">{t.icon}</div>
            {t.label}
          </button>
        ))}
      </div>
    </div>
  )
}
