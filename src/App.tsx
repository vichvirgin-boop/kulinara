import React, { useState, useRef, useCallback, useEffect } from 'react'

// ─── Storage adapter layer ──────────────────────────────────────────────────────
// Today this talks to localStorage. Long-term plan: swap `localAdapter` below
// for a Supabase-backed adapter (see SUPABASE_MIGRATION.md) so recipes sync
// across browser tabs, the installed PWA, and other devices — all without
// touching any call site in the app, since everything goes through `db`
// (the storage adapter interface: load(), save(db)).
const STORAGE_KEY = 'kulinara-db'
const LAST_BACKUP_KEY = 'kulinara-last-backup-at'

const localAdapter = {
  // Returns { recipes, libraryItems, loadError? }
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) {
        console.log('[kulinara] loadDB: no existing data in localStorage, starting fresh')
        return { recipes: [], libraryItems: [] }
      }
      const parsed = JSON.parse(raw)
      const recipes = Array.isArray(parsed.recipes) ? parsed.recipes : []
      const libraryItems = Array.isArray(parsed.libraryItems) ? parsed.libraryItems : []
      console.log(`[kulinara] loadDB: loaded ${recipes.length} recipes, ${libraryItems.length} libraryItems from localStorage`)
      return { recipes, libraryItems }
    } catch (e) {
      // A parse error means the stored data is corrupted, not absent.
      // We do NOT silently wipe it — we surface this loudly in the console
      // and let the UI show a recovery prompt instead.
      console.error('[kulinara] loadDB: failed to read/parse localStorage — data may be corrupted, NOT resetting.', e)
      return { recipes: [], libraryItems: [], loadError: true }
    }
  },
  // Returns true on success, false on failure (e.g. quota exceeded).
  save(db) {
    try {
      const json = JSON.stringify(db)
      localStorage.setItem(STORAGE_KEY, json)
      console.log(`[kulinara] saveDB: saved ${db.recipes?.length || 0} recipes, ${db.libraryItems?.length || 0} libraryItems (${json.length} chars) to localStorage`)
      return true
    } catch (e) {
      console.error('[kulinara] saveDB: FAILED to write to localStorage. Data was NOT persisted.', e)
      return false
    }
  },
}

// Active adapter. Swapping this single line (plus implementing a matching
// `{ load(), save(db) }` object backed by Supabase) is the entire migration
// path for cloud sync — no other code in this file needs to change.
const storage = localAdapter

/* ─── Future: Supabase adapter shape (see SUPABASE_MIGRATION.md) ───────────────
 *
 * import { createClient } from '@supabase/supabase-js'
 * const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY)
 *
 * const supabaseAdapter = {
 *   async load() {
 *     const { data: recipes }      = await supabase.from('recipes').select('*').order('added_at')
 *     const { data: libraryItems } = await supabase.from('library_items').select('*').order('added_at')
 *     return { recipes: recipes || [], libraryItems: libraryItems || [] }
 *   },
 *   async save(db) {
 *     // In practice you'd diff and upsert changed rows rather than
 *     // rewrite everything; this is illustrative only.
 *     const { error: e1 } = await supabase.from('recipes').upsert(db.recipes)
 *     const { error: e2 } = await supabase.from('library_items').upsert(db.libraryItems)
 *     return !e1 && !e2
 *   },
 * }
 * const storage = supabaseAdapter
 *
 * Everything else in this file — updateDB, handleAddRecipe, saveSelected,
 * deleteRecipe, handleImportBackup — already calls only loadDB()/saveDB(),
 * so none of it needs to change for cloud sync to work.
 * ────────────────────────────────────────────────────────────────────────────── */

function loadDB() { return storage.load() }
function saveDB(db) { return storage.save(db) }

// ─── Storage context detection ──────────────────────────────────────────────────
// localStorage is scoped per *browser engine + origin*. On iOS, Safari and
// Chrome each have their own storage even for the same URL, and an
// "Add to Home Screen" PWA gets yet another isolated storage container.
// This means recipes saved in one context are invisible in another — not a
// bug, just how browser storage works. We detect what we can and warn.
function detectStorageContext() {
  const isStandalone =
    (typeof window !== 'undefined' && window.navigator?.standalone === true) || // iOS PWA
    (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)')?.matches === true) // Android/desktop PWA

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  let browser = 'браузер'
  if (/CriOS/.test(ua)) browser = 'Chrome'
  else if (/FxiOS/.test(ua)) browser = 'Firefox'
  else if (/Safari/.test(ua) && !/CriOS|FxiOS/.test(ua)) browser = 'Safari'
  else if (/Chrome/.test(ua)) browser = 'Chrome'

  return {
    isStandalone,
    browser,
    label: isStandalone ? 'установленное приложение (PWA)' : `${browser} (вкладка браузера)`,
  }
}

function getLastBackupAt() {
  try { return localStorage.getItem(LAST_BACKUP_KEY) } catch { return null }
}
function setLastBackupAt(iso) {
  try { localStorage.setItem(LAST_BACKUP_KEY, iso) } catch { /* non-critical */ }
}

// ─── Backup: export / import / merge ───────────────────────────────────────────
function exportBackup(db) {
  const payload = {
    app: 'kulinara',
    version: 1,
    exportedAt: new Date().toISOString(),
    recipes: Array.isArray(db?.recipes) ? db.recipes : [],
    libraryItems: Array.isArray(db?.libraryItems) ? db.libraryItems : [],
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `kulinara-backup-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  setLastBackupAt(payload.exportedAt)
}

// Should we nudge the person to back up? True if they have data, AND either
// they've never backed up, or it's been more than 3 days since the last one.
function shouldSuggestBackup(db) {
  const hasData = (db?.recipes?.length || 0) > 0 || (db?.libraryItems?.length || 0) > 0
  if (!hasData) return false
  const lastBackup = getLastBackupAt()
  if (!lastBackup) return true
  const daysSince = (Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60 * 24)
  return daysSince > 3
}

// Validates that the parsed JSON looks like a backup we can use.
// Returns { ok: true, recipes, libraryItems } or { ok: false, error }
function validateBackup(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Файл повреждён или имеет неверный формат.' }
  }
  const recipes = Array.isArray(parsed.recipes) ? parsed.recipes : null
  const libraryItems = Array.isArray(parsed.libraryItems) ? parsed.libraryItems : null
  if (!recipes || !libraryItems) {
    return { ok: false, error: 'В файле не найдены рецепты или библиотека. Это не похоже на резервную копию Кулинары.' }
  }
  // Light shape-check on entries; tolerate extra/missing fields instead of crashing.
  const safeRecipes = recipes
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      id: typeof r.id === 'string' || typeof r.id === 'number' ? r.id : uid(),
      title: typeof r.title === 'string' ? r.title : '',
      ingredients: Array.isArray(r.ingredients) ? r.ingredients.filter((x) => typeof x === 'string') : [],
      steps: Array.isArray(r.steps) ? r.steps.filter((x) => typeof x === 'string') : [],
      time: typeof r.time === 'string' ? r.time : '',
      servings: typeof r.servings === 'string' ? r.servings : '',
      notes: typeof r.notes === 'string' ? r.notes : '',
      source: typeof r.source === 'string' ? r.source : 'manual',
      addedAt: typeof r.addedAt === 'string' ? r.addedAt : today(),
      editedAt: typeof r.editedAt === 'string' ? r.editedAt : undefined,
      favorite: r.favorite === true,
      tags: Array.isArray(r.tags) ? r.tags.filter((x) => typeof x === 'string') : [],
    }))
  const safeLibraryItems = libraryItems
    .filter((l) => l && typeof l === 'object')
    .map((l) => ({
      id: typeof l.id === 'string' || typeof l.id === 'number' ? l.id : uid(),
      name: typeof l.name === 'string' ? l.name : 'файл',
      type: l.type === 'pdf' ? 'pdf' : 'img',
      thumb: typeof l.thumb === 'string' ? l.thumb : null,
      recipesFound: Number.isFinite(l.recipesFound) ? l.recipesFound : 0,
      recipesImported: Number.isFinite(l.recipesImported) ? l.recipesImported : 0,
      addedAt: typeof l.addedAt === 'string' ? l.addedAt : today(),
    }))
  return { ok: true, recipes: safeRecipes, libraryItems: safeLibraryItems }
}

// Normalizes text for loose comparison: lowercase, trim, collapse whitespace,
// strip common punctuation. Used to catch near-duplicate recipes that have
// slightly different casing/spacing but are clearly the same recipe.
function normalizeForCompare(s) {
  return String(s ?? '')
    .toLowerCase()
    .trim()
    .replace(/[.,!?;:()"'«»]/g, '')
    .replace(/\s+/g, ' ')
}

// Returns true if two recipes look like the same recipe: same normalized
// title, OR same title length AND significant ingredient overlap. This is
// intentionally a bit loose — re-scanning the same cookbook page (even with
// slightly different OCR results) should be caught as a duplicate.
function recipesLookLikeDuplicates(a, b) {
  const ta = normalizeForCompare(a.title)
  const tb = normalizeForCompare(b.title)
  if (!ta || !tb) return false
  if (ta === tb) return true

  const ia = new Set((a.ingredients || []).map(normalizeForCompare).filter(Boolean))
  const ib = new Set((b.ingredients || []).map(normalizeForCompare).filter(Boolean))
  if (ia.size === 0 || ib.size === 0) return false
  let overlap = 0
  for (const x of ia) if (ib.has(x)) overlap++
  const overlapRatio = overlap / Math.min(ia.size, ib.size)
  // Same-ish title AND most ingredients match → almost certainly a duplicate.
  return ta.includes(tb) || tb.includes(ta) ? overlapRatio >= 0.5 : overlapRatio >= 0.8
}

// Filters out recipes from `candidates` that look like duplicates of
// anything already in `existing`. Returns { unique, duplicates }.
function dedupeRecipes(existing, candidates) {
  const unique = []
  const duplicates = []
  for (const c of candidates) {
    const isDup = existing.some((e) => recipesLookLikeDuplicates(e, c)) ||
                  unique.some((u) => recipesLookLikeDuplicates(u, c))
    if (isDup) duplicates.push(c)
    else unique.push(c)
  }
  return { unique, duplicates }
}

// Merge imported data into current db, de-duplicating by id AND by content
// (catches the case where a backup was made before a recipe got a new id,
// e.g. re-imported from a re-scanned photo).
function mergeBackup(currentDB, incoming) {
  const existingRecipeIds = new Set((currentDB?.recipes || []).map((r) => r.id))
  const existingLibIds    = new Set((currentDB?.libraryItems || []).map((l) => l.id))

  const byId = incoming.recipes.filter((r) => !existingRecipeIds.has(r.id))
  const { unique: newRecipes, duplicates: contentDupes } = dedupeRecipes(currentDB?.recipes || [], byId)
  const newLibraryItems = incoming.libraryItems.filter((l) => !existingLibIds.has(l.id))

  return {
    recipes:      [...(currentDB?.recipes || []),      ...newRecipes],
    libraryItems: [...(currentDB?.libraryItems || []), ...newLibraryItems],
    addedRecipes: newRecipes.length,
    addedLibraryItems: newLibraryItems.length,
    skippedRecipes: incoming.recipes.length - newRecipes.length,
  }
}

function readFileAsText(file) {
  return new Promise((res, rej) => {
    const r = new FileReader()
    r.onload  = () => res(r.result)
    r.onerror = rej
    r.readAsText(file)
  })
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

// Downscales an image file to a small JPEG thumbnail (max 160px) before it
// gets stored in localStorage. Full-resolution phone photos (often 3-5MB
// each as base64) blow through the ~5MB localStorage quota after just a
// couple of imports, which silently breaks persistence. A small thumbnail
// is enough for the Library list UI and keeps storage tiny.
function fileToThumbnail(file, maxSize = 160, quality = 0.7) {
  return new Promise((resolve) => {
    const img = new Image()
    const reader = new FileReader()
    reader.onload = () => {
      img.onload = () => {
        try {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height))
          const w = Math.max(1, Math.round(img.width * scale))
          const h = Math.max(1, Math.round(img.height * scale))
          const canvas = document.createElement('canvas')
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d')
          ctx.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch (e) {
          console.error('[kulinara] thumbnail generation failed, falling back to no thumbnail', e)
          resolve(null)
        }
      }
      img.onerror = () => resolve(null)
      img.src = reader.result
    }
    reader.onerror = () => resolve(null)
    reader.readAsDataURL(file)
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
  Download: () => <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  Restore:  () => <svg width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M3 12a9 9 0 109-9 9.75 9.75 0 00-6.74 2.74L3 8"/><polyline points="3 3 3 8 8 8"/></svg>,
  Warning:  () => <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Cloud:    () => <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path d="M18 10h-1.26A8 8 0 109 20h9a5 5 0 000-10z"/></svg>,
  X:        () => <svg width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
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
  const scanningText =
    job.progress < 20 ? 'Открываю файл…'
    : job.progress < 40 ? 'Загружаю на анализ…'
    : 'AI читает и распознаёт рецепты…'

  const statusText = {
    pending:  'В очереди…',
    scanning: scanningText,
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
  const [searchQuery, setSearchQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [activeTagFilter, setActiveTagFilter] = useState(null)

  // Recipe detail editing
  const [detailEditing, setDetailEditing] = useState(false)
  const [detailDraft, setDetailDraft] = useState(null)
  const [tagDraft, setTagDraft] = useState('')

  // Undo-delete (recipe is held here briefly so it can be restored)
  const [pendingDelete, setPendingDelete] = useState(null) // { recipe, index, timeoutId }
  const pendingDeleteRef = useRef(null)

  // Library import flow
  const [importStage,  setImportStage]  = useState('idle') // idle | processing | reviewing | saved
  const [jobs,         setJobs]         = useState([])
  const [reviewItems,  setReviewItems]  = useState([])
  const [dragOver,     setDragOver]     = useState(false)
  const [savedCount,   setSavedCount]   = useState(0)
  const [skippedDuplicates, setSkippedDuplicates] = useState(0)
  const fileRef = useRef()
  const importGenerationRef = useRef(0) // bumped on cancel/unmount to invalidate in-flight scans

  // Backup export / import
  const backupFileRef = useRef()
  const [backupStatus, setBackupStatus] = useState(null) // { type: 'ok'|'error', text }
  const [storageCtx, setStorageCtx] = useState(null)
  const [storageWarningDismissed, setStorageWarningDismissed] = useState(false)

  useEffect(() => {
    const loaded = loadDB()
    setDB(loaded)
    if (loaded.loadError) {
      setBackupStatus({ type: 'error', text: 'Не удалось прочитать сохранённые данные. Возможно, они повреждены.' })
    }
    setStorageCtx(detectStorageContext())
  }, [])

  const updateDB = useCallback((next) => {
    setDB(next)
    const ok = saveDB(next)
    if (!ok) {
      setBackupStatus({
        type: 'error',
        text: 'Не удалось сохранить данные на устройстве (возможно, не хватает места). Изменения видны сейчас, но могут не сохраниться после перезапуска. Рекомендуем скачать резервную копию.',
      })
    }
  }, [])

  // Everything that mutates `db` already writes to localStorage synchronously
  // inside updateDB/saveDB before the call returns, so there's no async save
  // queue to flush here. The one place edits can sit in memory without being
  // persisted yet is the recipe-detail edit form (detailDraft) — warn before
  // leaving so the person doesn't lose in-progress typing. We use both
  // `beforeunload` (closing the tab/app) and `pagehide` (iOS Safari often
  // skips beforeunload, especially in standalone PWA mode, but fires pagehide
  // reliably when backgrounding or closing).
  const detailEditingRef = useRef(false)
  useEffect(() => { detailEditingRef.current = detailEditing }, [detailEditing])

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (detailEditingRef.current) {
        e.preventDefault()
        e.returnValue = ''
        return ''
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [])

  // Defensive flush: if the active storage adapter is ever swapped for an
  // async one (e.g. Supabase), in-flight saves could still be pending when
  // the tab is backgrounded or closed. `dbRef` always points at the latest
  // committed state, so we can force one last synchronous save attempt.
  const dbRef = useRef(db)
  useEffect(() => { dbRef.current = db }, [db])

  useEffect(() => {
    const flush = () => { if (dbRef.current) saveDB(dbRef.current) }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // If the component unmounts mid-scan, invalidate the current import
  // generation so any still-running tickers/promises from handleFiles stop
  // touching state instead of leaking timers indefinitely. Also clear any
  // pending undo-delete timer so it doesn't fire after unmount.
  useEffect(() => {
    return () => {
      importGenerationRef.current++
      if (pendingDeleteRef.current?.timeoutId) clearTimeout(pendingDeleteRef.current.timeoutId)
    }
  }, [])

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
      const thumb = f.type.startsWith('image/') ? await fileToThumbnail(f) : null
      return makeFileJob(f, thumb)
    }))

    // Each call to handleFiles starts a new "generation". If the person
    // cancels, or the component unmounts, we bump the generation so any
    // still-running tickers/state-updates below recognize they're stale and
    // stop touching state — otherwise a cancelled scan could "complete" in
    // the background and silently repopulate the review screen.
    const generation = ++importGenerationRef.current

    setJobs(jobList)
    setImportStage('processing')
    setReviewItems([])

    // Process all files in parallel rather than one-at-a-time — each is an
    // independent API call, so waiting for file 1 to fully finish before
    // even starting file 2 was pure wasted time. While each one waits on the
    // network, nudge its progress bar forward gradually so it never looks
    // stuck, instead of jumping 30% → 60% → 100% with a long pause at 60%.
    const results = await Promise.all(jobList.map(async (job) => {
      const isStale = () => importGenerationRef.current !== generation
      if (isStale()) return null

      patchJob(job.id, { status: 'scanning', progress: 8 })

      const tick = setInterval(() => {
        if (isStale()) { clearInterval(tick); return }
        setJobs((prev) => prev.map((j) =>
          j.id === job.id && j.status === 'scanning' && j.progress < 88
            ? { ...j, progress: j.progress + (88 - j.progress) * 0.18 }
            : j
        ))
      }, 350)

      try {
        const base64 = await fileToBase64(job.file)
        if (isStale()) { clearInterval(tick); return null }
        patchJob(job.id, { progress: 35 })

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

        clearInterval(tick)
        if (isStale()) return null
        patchJob(job.id, { status: 'done', progress: 100, recipes })

        return recipes.length > 0
          ? { jobId: job.id, jobName: job.name, jobType: job.type, thumb: job.thumb, recipes, selected: recipes.map((r) => r.id) }
          : null
      } catch (e) {
        clearInterval(tick)
        if (isStale()) return null
        patchJob(job.id, { status: 'error', progress: 100, error: e.message || String(e) })
        return null
      }
    }))

    if (importGenerationRef.current !== generation) return // cancelled/unmounted — don't resurrect the review screen

    setReviewItems(results.filter(Boolean))
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
    const { unique, duplicates } = dedupeRecipes(db?.recipes || [], toSave)
    const libItems = jobs.map((j) => ({
      id: uid(), name: j.name, type: j.type, thumb: j.thumb,
      recipesFound:    j.recipes.length,
      recipesImported: reviewItems.find((ri) => ri.jobId === j.id)?.selected.length || 0,
      addedAt: today(),
    }))
    updateDB({
      recipes:      [...(db?.recipes || []),      ...unique],
      libraryItems: [...(db?.libraryItems || []), ...libItems],
    })
    setSavedCount(unique.length)
    setSkippedDuplicates(duplicates.length)
    setImportStage('saved')
  }

  const resetImport = () => {
    importGenerationRef.current++ // invalidates any in-flight scan tickers/promises
    setImportStage('idle'); setJobs([]); setReviewItems([]); setSavedCount(0); setSkippedDuplicates(0)
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

  // Deletes a recipe immediately (so it's actually gone from storage — no
  // data sits in limbo) but keeps a copy + its original index around for a
  // few seconds so the person can undo via a toast.
  const handleDeleteRecipe = (recipe) => {
    const recipes = db?.recipes || []
    const index = recipes.findIndex((r) => r.id === recipe.id)
    if (index === -1) return

    updateDB({ ...db, recipes: recipes.filter((r) => r.id !== recipe.id) })
    setSelectedRecipe(null)
    setDetailEditing(false)

    if (pendingDeleteRef.current?.timeoutId) clearTimeout(pendingDeleteRef.current.timeoutId)
    const timeoutId = setTimeout(() => {
      setPendingDelete(null)
      pendingDeleteRef.current = null
    }, 6000)
    const entry = { recipe, index, timeoutId }
    pendingDeleteRef.current = entry
    setPendingDelete(entry)
  }

  const undoDelete = () => {
    const entry = pendingDeleteRef.current
    if (!entry) return
    clearTimeout(entry.timeoutId)
    let saveOk = true
    setDB((prevDb) => {
      const recipes = [...(prevDb?.recipes || [])]
      const insertAt = Math.min(entry.index, recipes.length)
      recipes.splice(insertAt, 0, entry.recipe)
      const next = { ...prevDb, recipes }
      saveOk = saveDB(next)
      return next
    })
    if (!saveOk) {
      setBackupStatus({
        type: 'error',
        text: 'Рецепт восстановлен на экране, но не удалось сохранить его на устройстве. Рекомендуем скачать резервную копию.',
      })
    }
    setPendingDelete(null)
    pendingDeleteRef.current = null
  }

  const deleteLibItem = (id) => { updateDB({ ...db, libraryItems: db.libraryItems.filter((l) => l.id !== id) }) }

  // ── Recipe detail: edit / favorite / tags ───────────────────────────────────
  const openRecipeDetail = (recipe) => {
    setSelectedRecipe(recipe)
    setDetailEditing(false)
    setDetailDraft(null)
    setTagDraft('')
  }

  const closeRecipeDetail = () => {
    if (detailEditing) {
      const confirmed = window.confirm('Изменения не сохранены. Закрыть без сохранения?')
      if (!confirmed) return
    }
    setSelectedRecipe(null)
    setDetailEditing(false)
    setDetailDraft(null)
    setTagDraft('')
  }

  const startDetailEdit = () => {
    if (!selectedRecipe) return
    setDetailDraft({
      title: selectedRecipe.title || '',
      ingredients: selectedRecipe.ingredients?.length ? [...selectedRecipe.ingredients] : [''],
      steps: selectedRecipe.steps?.length ? [...selectedRecipe.steps] : [''],
      time: selectedRecipe.time || '',
      servings: selectedRecipe.servings || '',
      notes: selectedRecipe.notes || '',
      tags: selectedRecipe.tags ? [...selectedRecipe.tags] : [],
    })
    setDetailEditing(true)
  }

  const cancelDetailEdits = () => {
    setDetailEditing(false)
    setDetailDraft(null)
    setTagDraft('')
  }

  const saveDetailEdits = () => {
    if (!selectedRecipe || !detailDraft) return
    const cleaned = {
      ...selectedRecipe,
      title: detailDraft.title.trim() || selectedRecipe.title,
      ingredients: detailDraft.ingredients.map((s) => s.trim()).filter(Boolean),
      steps: detailDraft.steps.map((s) => s.trim()).filter(Boolean),
      time: detailDraft.time.trim(),
      servings: detailDraft.servings.trim(),
      notes: detailDraft.notes.trim(),
      tags: detailDraft.tags,
      editedAt: today(),
    }
    const recipes = (db?.recipes || []).map((r) => r.id === cleaned.id ? cleaned : r)
    updateDB({ ...db, recipes })
    setSelectedRecipe(cleaned)
    setDetailEditing(false)
    setDetailDraft(null)
    setTagDraft('')
  }

  const toggleFavorite = (id) => {
    const recipes = (db?.recipes || []).map((r) => r.id === id ? { ...r, favorite: !r.favorite } : r)
    updateDB({ ...db, recipes })
    setSelectedRecipe((prev) => prev && prev.id === id ? { ...prev, favorite: !prev.favorite } : prev)
  }

  // ── Backup: export ───────────────────────────────────────────────────────────
  const handleExportBackup = () => {
    try {
      exportBackup(db)
      setBackupStatus({ type: 'ok', text: 'Резервная копия скачана.' })
    } catch (e) {
      setBackupStatus({ type: 'error', text: 'Не удалось создать файл резервной копии.' })
    }
  }

  // ── Backup: import ───────────────────────────────────────────────────────────
  const handleImportBackup = async (file) => {
    if (!file) return
    setBackupStatus(null)
    try {
      const text = await readFileAsText(file)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        setBackupStatus({ type: 'error', text: 'Файл не является корректным JSON.' })
        return
      }
      const validated = validateBackup(parsed)
      if (!validated.ok) {
        setBackupStatus({ type: 'error', text: validated.error })
        return
      }
      const merged = mergeBackup(db, validated)
      updateDB({ recipes: merged.recipes, libraryItems: merged.libraryItems })
      setLastBackupAt(new Date().toISOString())
      const parts = []
      if (merged.addedRecipes > 0) parts.push(`+${merged.addedRecipes} рецептов`)
      if (merged.addedLibraryItems > 0) parts.push(`+${merged.addedLibraryItems} файлов`)
      if (merged.skippedRecipes > 0) parts.push(`${merged.skippedRecipes} уже было`)
      setBackupStatus({
        type: 'ok',
        text: parts.length ? `Восстановлено: ${parts.join(', ')}.` : 'В файле не было новых данных.',
      })
    } catch (e) {
      setBackupStatus({ type: 'error', text: 'Не удалось прочитать файл. Попробуйте другой файл резервной копии.' })
    } finally {
      if (backupFileRef.current) backupFileRef.current.value = ''
    }
  }

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

  // Search across title, ingredients, and steps (instructions) — not just
  // ingredients like the AI Home-tab matcher. Plain substring match, case
  // and punctuation insensitive, so it works instantly without an API call.
  // Tags are deduplicated case-insensitively (so "Завтрак" and "завтрак"
  // collapse into one filter pill) while keeping the first-seen casing.
  const allTags = (() => {
    const seen = new Map() // lowercase -> original casing
    for (const r of recipes) {
      for (const t of r.tags || []) {
        const key = t.toLowerCase()
        if (!seen.has(key)) seen.set(key, t)
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'ru'))
  })()
  const searchNorm = normalizeForCompare(searchQuery)
  const filteredRecipes = recipes.filter((r) => {
    if (favoritesOnly && !r.favorite) return false
    if (activeTagFilter && !(r.tags || []).some((t) => t.toLowerCase() === activeTagFilter.toLowerCase())) return false
    if (!searchNorm) return true
    const haystack = normalizeForCompare(
      [r.title, ...(r.ingredients || []), ...(r.steps || []), r.notes || ''].join(' ')
    )
    return haystack.includes(searchNorm)
  })

  return (
    <div className="app">

      {/* ── Recipe detail overlay ── */}
      {selectedRecipe && (
        <div className="detail-overlay">
          <div className="detail-topbar">
            <button className="btn ghost sm" onClick={closeRecipeDetail}>← Назад</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`btn ${detailEditing ? 'green-btn' : 'ghost'} sm`}
                onClick={() => detailEditing ? saveDetailEdits() : startDetailEdit()}
              >
                {detailEditing ? <><Ico.Check /> Готово</> : <>✎ Изменить</>}
              </button>
              <button className="btn danger sm" onClick={() => handleDeleteRecipe(selectedRecipe)}>
                <Ico.Trash />
              </button>
            </div>
          </div>
          <div style={{ padding: '16px 16px 80px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              {selectedRecipe.source && selectedRecipe.source !== 'manual' && <span className="badge ai">AI</span>}
              <button
                className="btn ghost xs"
                onClick={() => toggleFavorite(selectedRecipe.id)}
                style={{ color: selectedRecipe.favorite ? '#FF6B35' : undefined }}
                aria-label="В избранное"
              >
                {selectedRecipe.favorite ? '★' : '☆'} Избранное
              </button>
            </div>

            {!detailEditing ? (
              <h1 style={{ fontFamily: "'Syne',sans-serif", fontSize: 24, fontWeight: 800, marginBottom: 6 }}>
                {selectedRecipe.title}
              </h1>
            ) : (
              <input className="input mb8" style={{ fontFamily: "'Syne',sans-serif", fontSize: 18, fontWeight: 700 }}
                value={detailDraft.title} onChange={(e) => setDetailDraft({ ...detailDraft, title: e.target.value })} placeholder="Название рецепта" />
            )}

            <div className="card-meta" style={{ marginBottom: 12 }}>
              {selectedRecipe.time     && <span>⏱ {selectedRecipe.time}</span>}
              {selectedRecipe.servings && <span>🍽 {selectedRecipe.servings}</span>}
              {selectedRecipe.addedAt  && <span>📅 добавлен {selectedRecipe.addedAt}</span>}
              {selectedRecipe.editedAt && selectedRecipe.editedAt !== selectedRecipe.addedAt && (
                <span>✎ изменён {selectedRecipe.editedAt}</span>
              )}
            </div>

            {detailEditing && (
              <div className="row2 mb16">
                <div style={{ flex: 1 }}>
                  <div className="review-label">Время</div>
                  <input className="input" style={{ fontSize: 13, padding: '8px 12px' }}
                    value={detailDraft.time} onChange={(e) => setDetailDraft({ ...detailDraft, time: e.target.value })} placeholder="45 мин" />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="review-label">Порции</div>
                  <input className="input" style={{ fontSize: 13, padding: '8px 12px' }}
                    value={detailDraft.servings} onChange={(e) => setDetailDraft({ ...detailDraft, servings: e.target.value })} placeholder="4" />
                </div>
              </div>
            )}

            {/* Tags */}
            <div className="sec-label" style={{ marginTop: detailEditing ? 0 : 20 }}>Теги</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: detailEditing ? 8 : 20, alignItems: 'center' }}>
              {(detailEditing ? detailDraft.tags : selectedRecipe.tags || [])?.map((tag, i) => (
                <span key={i} className="pill" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {tag}
                  {detailEditing && (
                    <span onClick={() => setDetailDraft({ ...detailDraft, tags: detailDraft.tags.filter((_, j) => j !== i) })}
                      style={{ cursor: 'pointer', color: '#8B8FA8' }}>×</span>
                  )}
                </span>
              ))}
              {!detailEditing && (!selectedRecipe.tags || selectedRecipe.tags.length === 0) && (
                <span style={{ fontSize: 12, color: '#8B8FA8' }}>Нет тегов</span>
              )}
              {detailEditing && (
                <input
                  className="input" style={{ fontSize: 12, padding: '5px 10px', width: 110 }}
                  placeholder="+ тег, Enter"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && tagDraft.trim()) {
                      const t = tagDraft.trim()
                      const exists = detailDraft.tags.some((existing) => existing.toLowerCase() === t.toLowerCase())
                      if (!exists) {
                        setDetailDraft({ ...detailDraft, tags: [...detailDraft.tags, t] })
                      }
                      setTagDraft('')
                    }
                  }}
                />
              )}
            </div>

            {/* Ingredients */}
            {!detailEditing ? (
              selectedRecipe.ingredients?.length > 0 && (
                <>
                  <div className="sec-label">Ингредиенты</div>
                  <div style={{ marginBottom: 20 }}>
                    {selectedRecipe.ingredients.map((ing, i) => <span key={i} className="pill">{ing}</span>)}
                  </div>
                </>
              )
            ) : (
              <>
                <div className="sec-label">Ингредиенты</div>
                {detailDraft.ingredients.map((ing, i) => (
                  <div key={i} className="row2" style={{ marginBottom: 4 }}>
                    <input className="input" style={{ fontSize: 13, padding: '8px 12px' }}
                      value={ing}
                      onChange={(e) => {
                        const a = [...detailDraft.ingredients]; a[i] = e.target.value
                        setDetailDraft({ ...detailDraft, ingredients: a })
                      }}
                      placeholder={`Ингредиент ${i + 1}`} />
                    <button className="btn ghost xs" onClick={() => setDetailDraft({ ...detailDraft, ingredients: detailDraft.ingredients.filter((_, j) => j !== i) })}>
                      <Ico.Trash />
                    </button>
                  </div>
                ))}
                <button className="btn ghost xs mb16" onClick={() => setDetailDraft({ ...detailDraft, ingredients: [...detailDraft.ingredients, ''] })}>
                  <Ico.Plus /> Добавить ингредиент
                </button>
              </>
            )}

            {/* Steps */}
            {!detailEditing ? (
              selectedRecipe.steps?.length > 0 && (
                <>
                  <div className="sec-label">Приготовление</div>
                  {selectedRecipe.steps.map((s, i) => (
                    <div key={i} className="step-row">
                      <div className="step-num">{i + 1}</div>
                      <p style={{ fontSize: 14, lineHeight: 1.65, paddingTop: 3 }}>{s}</p>
                    </div>
                  ))}
                </>
              )
            ) : (
              <>
                <div className="sec-label">Приготовление</div>
                {detailDraft.steps.map((step, i) => (
                  <div key={i} className="row2" style={{ marginBottom: 4, alignItems: 'flex-start' }}>
                    <div className="step-num" style={{ marginTop: 6 }}>{i + 1}</div>
                    <textarea className="input" style={{ fontSize: 13, padding: '8px 12px', minHeight: 56 }}
                      value={step}
                      onChange={(e) => {
                        const a = [...detailDraft.steps]; a[i] = e.target.value
                        setDetailDraft({ ...detailDraft, steps: a })
                      }}
                      placeholder={`Шаг ${i + 1}`} />
                    <button className="btn ghost xs" style={{ marginTop: 6 }} onClick={() => setDetailDraft({ ...detailDraft, steps: detailDraft.steps.filter((_, j) => j !== i) })}>
                      <Ico.Trash />
                    </button>
                  </div>
                ))}
                <button className="btn ghost xs mb16" onClick={() => setDetailDraft({ ...detailDraft, steps: [...detailDraft.steps, ''] })}>
                  <Ico.Plus /> Добавить шаг
                </button>
              </>
            )}

            {/* Notes */}
            {!detailEditing ? (
              selectedRecipe.notes && (
                <>
                  <div className="sec-label">Заметки</div>
                  <p style={{ fontSize: 13, color: '#8B8FA8', lineHeight: 1.55 }}>{selectedRecipe.notes}</p>
                </>
              )
            ) : (
              <>
                <div className="sec-label">Заметки</div>
                <textarea className="input" value={detailDraft.notes}
                  onChange={(e) => setDetailDraft({ ...detailDraft, notes: e.target.value })} />
              </>
            )}

            {detailEditing && (
              <div className="row2" style={{ marginTop: 16 }}>
                <button className="btn ghost full" onClick={cancelDetailEdits}>Отмена</button>
                <button className="btn green-btn full" onClick={saveDetailEdits}><Ico.Check /> Сохранить</button>
              </div>
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="eyebrow">
              {tab === 'home' ? 'что приготовить?' : tab === 'recipes' ? 'все рецепты' : 'моя библиотека'}
            </div>
            <div className="page-title">
              {tab === 'home'    && <><span>Кулина</span>ра</>}
              {tab === 'recipes' && <>Рецепты</>}
              {tab === 'library' && <>Библиотека</>}
            </div>
          </div>
          {storageCtx && (
            <button
              className="context-pill"
              onClick={() => setTab('library')}
              title="Данные хранятся только в этом браузере/приложении"
              style={{ marginTop: 4, cursor: 'pointer' }}
            >
              <Ico.Cloud /> {storageCtx.isStandalone ? 'PWA' : storageCtx.browser}
            </button>
          )}
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

            {aiLoading && (
              <div className="ai-bubble" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="spin sm" />
                <span style={{ fontSize: 13, color: '#8B8FA8' }}>AI смотрит на ваши рецепты и подбирает подходящие…</span>
              </div>
            )}

            {!aiLoading && aiAnswer && (
              <div className="ai-bubble">
                <div className="ai-label"><Ico.Star /> AI-подбор</div>
                {aiAnswer}
              </div>
            )}

            {recipes.length > 0 && (
              <>
                <div className="sec-label">Последние рецепты</div>
                {recipes.slice(-3).reverse().map((r) => (
                  <div key={r.id} className="card clickable" onClick={() => openRecipeDetail(r)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div className="card-title">{r.favorite && '★ '}{r.title}</div>
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

            {recipes.length === 0 && !aiAnswer && !aiError && !aiLoading && (
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

            {recipes.length > 0 && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                  <input
                    className="input"
                    placeholder="Поиск по названию, ингредиентам, шагам…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  <button
                    className={`btn ${favoritesOnly ? '' : 'ghost'} sm`}
                    onClick={() => setFavoritesOnly((v) => !v)}
                    style={favoritesOnly ? { background: '#FF6B35' } : {}}
                    aria-label="Только избранное"
                  >
                    {favoritesOnly ? '★' : '☆'}
                  </button>
                </div>

                {allTags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                    {allTags.map((tag) => (
                      <button
                        key={tag}
                        className="pill"
                        onClick={() => setActiveTagFilter((t) => t === tag ? null : tag)}
                        style={{
                          cursor: 'pointer',
                          border: activeTagFilter === tag ? '1px solid #FF6B35' : '1px solid #2E3248',
                          color: activeTagFilter === tag ? '#FF6B35' : '#F0EDE8',
                        }}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {recipes.length === 0 ? (
              <div className="empty">
                <div className="empty-emoji">📖</div>
                <h3>Нет рецептов</h3>
                <p>Добавьте рецепт вручную или загрузите фото кулинарной книги в Библиотеку.</p>
                <button className="btn" style={{ margin: '16px auto 0', display: 'flex' }} onClick={() => setShowAddModal(true)}>
                  <Ico.Plus /> Добавить рецепт
                </button>
              </div>
            ) : filteredRecipes.length === 0 ? (
              <div className="empty">
                <div className="empty-emoji">🔍</div>
                <h3>Ничего не найдено</h3>
                <p>Попробуйте изменить запрос или сбросить фильтры.</p>
                {(searchQuery || favoritesOnly || activeTagFilter) && (
                  <button className="btn ghost" style={{ margin: '16px auto 0', display: 'flex' }}
                    onClick={() => { setSearchQuery(''); setFavoritesOnly(false); setActiveTagFilter(null) }}>
                    Сбросить фильтры
                  </button>
                )}
              </div>
            ) : filteredRecipes.map((r) => (
              <div key={r.id} className="card clickable" onClick={() => openRecipeDetail(r)}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                  <div className="card-title">{r.favorite && '★ '}{r.title}</div>
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
                {r.tags?.length > 0 && (
                  <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {r.tags.map((tag, i) => (
                      <span key={i} className="pill" style={{ fontSize: 11, color: '#8B8FA8' }}>{tag}</span>
                    ))}
                  </div>
                )}
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
                {storageCtx && !storageWarningDismissed && (
                  <div className="storage-banner">
                    <div className="storage-banner-icon"><Ico.Warning /></div>
                    <div className="storage-banner-body">
                      <div className="storage-banner-title">Данные хранятся только на этом устройстве</div>
                      <div className="storage-banner-text">
                        Сейчас вы используете: <strong style={{ color: '#F0EDE8' }}>{storageCtx.label}</strong>.
                        {' '}Safari, Chrome и установленное на главный экран приложение (PWA) хранят данные отдельно друг от друга —
                        даже на одном телефоне. Рецепты, сохранённые здесь, <strong style={{ color: '#F0EDE8' }}>не появятся</strong> в другом браузере
                        или после переустановки. Регулярно скачивайте резервную копию ниже.
                      </div>
                    </div>
                    <button className="storage-banner-close" onClick={() => setStorageWarningDismissed(true)} aria-label="Закрыть">
                      <Ico.X />
                    </button>
                  </div>
                )}

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

                <div className="sec-label">Резервная копия</div>
                {db && shouldSuggestBackup(db) && (
                  <div className="backup-nudge">
                    <Ico.Warning />
                    <span>
                      {getLastBackupAt()
                        ? <>Последняя копия — давно. <strong>Скачайте свежую</strong>, чтобы не потерять рецепты.</>
                        : <>У вас ещё нет резервной копии. <strong>Скачайте её сейчас</strong> — это защитит рецепты при смене браузера или устройства.</>}
                    </span>
                  </div>
                )}
                <input ref={backupFileRef} type="file" accept="application/json,.json" style={{ display: 'none' }}
                  onChange={(e) => handleImportBackup(e.target.files?.[0])} />
                <div className="row2" style={{ marginBottom: 10 }}>
                  <button className="btn ghost full" onClick={handleExportBackup}>
                    <Ico.Download /> Скачать резервную копию
                  </button>
                  <button className="btn ghost full" onClick={() => backupFileRef.current?.click()}>
                    <Ico.Restore /> Восстановить из файла
                  </button>
                </div>
                {backupStatus && (
                  <div className={`notice ${backupStatus.type === 'error' ? 'error' : ''}`}>
                    {backupStatus.type === 'error' ? '⚠ ' : '✓ '}{backupStatus.text}
                  </div>
                )}
              </>
            )}

            {/* PROCESSING */}
            {importStage === 'processing' && (
              <>
                <div className="sec-label">Сканирование файлов</div>
                <div className="pipeline">
                  {jobs.map((j) => <FileJobRow key={j.id} job={j} />)}
                </div>
                <p style={{ fontSize: 12, color: '#8B8FA8', textAlign: 'center', marginTop: 10, marginBottom: 14 }}>
                  {jobs.length > 1 ? `Обрабатываю ${jobs.length} файла одновременно…` : 'AI анализирует содержимое…'}
                </p>
                <button className="btn ghost full" onClick={resetImport}>Отменить</button>
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
                  <div style={{ fontSize: 52, marginBottom: 12 }}>{savedCount > 0 ? '🎉' : '🤔'}</div>
                  <div style={{ fontFamily: "'Syne',sans-serif", fontSize: 22, fontWeight: 800, marginBottom: 6 }}>
                    {savedCount > 0 ? 'Сохранено!' : 'Уже есть в базе'}
                  </div>
                  {savedCount > 0 && (
                    <p style={{ fontSize: 14, color: '#8B8FA8' }}>
                      {savedCount} {savedCount === 1 ? 'рецепт добавлен' : 'рецептов добавлено'} в базу
                    </p>
                  )}
                  {skippedDuplicates > 0 && (
                    <p style={{ fontSize: 12, color: '#F5C842', marginTop: 6 }}>
                      {skippedDuplicates} {skippedDuplicates === 1 ? 'рецепт пропущен' : 'рецептов пропущено'} — уже есть в базе
                    </p>
                  )}
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

      {/* ── Undo delete toast ── */}
      {pendingDelete && (
        <div className="undo-toast">
          <span>Рецепт «{pendingDelete.recipe.title || 'Без названия'}» удалён</span>
          <button className="btn ghost xs" onClick={undoDelete}>Отменить</button>
        </div>
      )}

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
