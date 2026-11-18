// ===== app.js : NextStep application logic (Davao edition, talks to the Flask backend) =====
'use strict'; // strict mode catches common coding mistakes

const DAVAO_CENTER = [7.0731, 125.6128]; // latitude, longitude of Davao City centre (same as config.py)
const DAVAO_BOUNDS = [[6.90, 125.20], [7.50, 125.80]]; // [[south, west], [north, east]] map limits (same as config.py)
const CLIENT_KEY = 'nextstep_client_id'; // localStorage key for the anonymous browser id
const $ = (s) => document.querySelector(s); // shortcut: get one element
const $$ = (s) => [...document.querySelectorAll(s)]; // shortcut: get many elements as an array
const avg = (a) => (a.length ? a.reduce((t, x) => t + x, 0) / a.length : 0); // average of a number list (0 if empty)
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); // escape text to prevent HTML injection

function makeClientId() { // create or reuse a random id so each browser keeps its own history on the server
  let id = null; // id found in storage
  try { id = localStorage.getItem(CLIENT_KEY); } catch (e) { id = null; } // read it (storage may be blocked)
  if (!id) { // first visit
    id = (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)); // random id
    try { localStorage.setItem(CLIENT_KEY, id); } catch (e) { /* ignore blocked storage */ } // remember it
  } // end if
  return id; // the id
} // end makeClientId
const CLIENT_ID = makeClientId(); // this browser's id

const state = { // all changing data lives here
  g11: [], // Grade 11 subjects: {name, type, grade}
  g12: [], // Grade 12 subjects
  history: [], // saved assessment records (from the server)
  selectedId: null, // history record currently selected
  results: null, // latest top-5 results
  resultsId: null, // id of the assessment shown in the results card (separate from the History selection)
  schools: [], // Davao schools with map pins (from the server)
  catalog: Object.create(null), // lowercase subject name -> type (no prototype, so typing "constructor" is safe)
  userPos: null, // user's GPS position {lat, lng}
  locStatus: 'Locating you...', // text for the location pill
  located: false, // true after the first GPS fix has zoomed the map
  map: null, // Leaflet map object
  allLayer: null, // group with a small pin for every school
  topLayer: null, // group with the numbered top-5 pins
  dlgLevel: 11, // grade level the dialog is adding to
  typeTouched: false // true when the student picked the classification by hand
}; // end of state

// ---------- server calls ----------
async function api(path, options = {}) { // call the backend and return its JSON
  const res = await fetch('/api' + path, { // send the request
    ...options, // method and body from the caller
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID, ...(options.headers || {}) } // JSON + browser id
  }); // end fetch
  const data = await res.json().catch(() => ({})); // parse JSON (empty object if it fails)
  if (!res.ok) throw new Error(data.error || `Server error (${res.status})`); // turn HTTP errors into exceptions
  return data; // parsed reply
} // end api

// ---------- small helpers ----------
function toast(msg) { // show a short message
  const t = $('#toast'); // get toast element
  t.textContent = msg; // set its text
  t.classList.add('show'); // make it visible
  setTimeout(() => t.classList.remove('show'), 3000); // hide after 3 seconds
} // end toast
function todayLabel() { return new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: '2-digit', day: '2-digit', year: 'numeric' }); } // MM/DD/YYYY in Philippine time
function tierOf(pct) { return pct >= 85 ? 'strong' : pct >= 75 ? 'good' : 'fair'; } // match tier from percent
function inDavao(p) { return p.lat >= DAVAO_BOUNDS[0][0] && p.lat <= DAVAO_BOUNDS[1][0] && p.lng >= DAVAO_BOUNDS[0][1] && p.lng <= DAVAO_BOUNDS[1][1]; } // is a position inside the Davao box?
function schoolName(id) { const s = state.schools.find((x) => x.id === id); return s ? s.name : id; } // school id -> name

// ---------- subject tables ----------
function renderSubjects() { // draw both grade tables
  [11, 12].forEach((lvl) => { // loop Grade 11 then Grade 12
    const list = state['g' + lvl]; // subjects for this level
    $('#body' + lvl).innerHTML = list.map((s, i) => `<tr><td>${esc(s.name)}</td><td><span class="type ${s.type}">${s.type}</span></td><td><b>${s.grade}</b></td><td><button class="x" data-del="${lvl}:${i}" aria-label="Remove ${esc(s.name)}">&times;</button></td></tr>`).join(''); // build rows
    $('#count' + lvl).textContent = `${list.length} Subject${list.length === 1 ? '' : 's'}`; // update count pill
    $('#avg' + lvl).textContent = list.length ? avg(list.map((s) => s.grade)).toFixed(1) : '--'; // update average
  }); // end loop
  updateReady(); // re-check the submit requirements
} // end renderSubjects

function validation() { // returns an error string or '' when ready
  const raw = $('#encae').value; // ENCAE text
  const e = Number(raw); // ENCAE as number
  if (!state.g11.length) return 'Add at least 1 Grade 11 subject.'; // need Grade 11
  if (!state.g12.length) return 'Add at least 1 Grade 12 subject.'; // need Grade 12
  if (raw === '' || !Number.isFinite(e) || e < 1 || e > 100) return 'Enter a valid ENCAE percentile between 1 and 100.'; // need ENCAE
  return ''; // everything is fine
} // end validation
function updateReady() { // refresh requirement text
  const err = validation(); // current problem, if any
  $('#reqText').textContent = err || 'All requirements met. Ready to analyze.'; // message
  $('#reqText').classList.toggle('bad', !!err && ($('#encae').value !== '' || state.g11.length + state.g12.length > 0)); // red only after the user started
} // end updateReady

// ---------- add-subject dialog (students can TYPE any subject) ----------
function openDialog(lvl) { // open the pop-up
  state.dlgLevel = lvl; // remember which grade level
  state.typeTouched = false; // allow auto-detection again
  $('#dlgTitle').textContent = `Add Grade ${lvl} Subject`; // set title
  ['#subName', '#subGrade'].forEach((s) => ($(s).value = '')); // clear inputs
  $('#subType').value = 'Core'; // default classification
  $('#typeHint').textContent = 'Type any subject name, or pick one from the suggestions.'; // hint
  $('#dlgError').textContent = ''; // clear error
  $('#dlgSave').disabled = false; // Save is allowed again
  $('#subjectDialog').showModal(); // show the dialog
  $('#subName').focus(); // focus the name field
} // end openDialog
function applyType(type, msg) { // set the classification dropdown and hint
  if (state.typeTouched) { $('#typeHint').textContent = 'Using the classification you chose.'; return; } // keep the manual choice and say so
  $('#subType').value = type; // apply the detected type
  $('#typeHint').textContent = msg; // tell the student how it was detected
} // end applyType
let classifyTimer = null; // timer used to wait until the student stops typing
function onNameInput() { // classify while the student types
  const name = $('#subName').value.trim(); // typed name
  clearTimeout(classifyTimer); // cancel the previous wait
  $('#dlgSave').disabled = false; // typing started over: allow saving unless a check starts below
  if (!name) { $('#typeHint').textContent = 'Type any subject name, or pick one from the suggestions.'; return; } // nothing typed
  const known = state.catalog[name.toLowerCase().split(/\s+/).join(' ')]; // exact match in the DepEd list (spaces normalised like the server)
  if (known) { applyType(known, `Detected as a ${known} subject (DepEd list). You can change it.`); return; } // done instantly
  $('#typeHint').textContent = 'Checking classification...'; // working message
  $('#dlgSave').disabled = true; // wait for the answer so the default type is not saved by accident
  classifyTimer = setTimeout(async () => { // wait 450 ms after the last keystroke
    try { // ask the server (keyword rules, then AI)
      const r = await api('/classify', { method: 'POST', body: JSON.stringify({ name }) }); // classify request
      if ($('#subName').value.trim() !== name) return; // the student kept typing; ignore this answer (the newer check will re-enable Save)
      $('#dlgSave').disabled = false; // answer arrived
      if (r.source === 'default') $('#typeHint').textContent = 'Could not identify this subject. Please choose its classification.'; // unknown
      else applyType(r.type, `Detected as a ${r.type} subject (${r.source === 'ai' ? 'by AI' : 'by keywords'}). You can change it.`); // known
    } catch (e) { $('#dlgSave').disabled = false; $('#typeHint').textContent = 'Could not check automatically. Please choose its classification.'; } // server problem: let the student choose
  }, 450); // delay in ms
} // end onNameInput
function saveSubject() { // validate and store the subject
  const name = $('#subName').value.trim().replace(/\s+/g, ' '); // typed name with tidy spaces
  const type = $('#subType').value; // chosen classification
  const grade = Number($('#subGrade').value); // typed grade
  const list = state['g' + state.dlgLevel]; // target list
  let err = ''; // validation message
  if (!name) err = 'Enter the subject name.'; // name required
  else if (name.length > 80) err = 'Subject name is too long (max 80 characters).'; // length limit
  else if (!(grade >= 60 && grade <= 100)) err = 'Grade must be between 60 and 100.'; // grade range
  else if (list.some((s) => s.name.toLowerCase() === name.toLowerCase())) err = 'That subject is already in this grade level.'; // no duplicates
  $('#dlgError').textContent = err; // show message
  if (err) return; // stop on error
  list.push({ name, type, grade }); // save subject
  $('#subjectDialog').close(); // close dialog
  renderSubjects(); // redraw tables
} // end saveSubject

// ---------- results ----------
function renderResults(res) { // draw the top-5 list
  if (!res) return; // nothing to draw
  $('#results').innerHTML = `<div class="match-list">${res.map((r, i) => { // one card per match
    const crumbs = r.breakdown.length // subjects that count toward this degree
      ? r.breakdown.map((b) => `<span class="chip ${b.meets ? 'ok' : 'warn'}">${esc(b.name)} ${b.grade}</span>`).join('') // one chip per subject
      : '<span class="muted small">No directly related subjects entered.</span>'; // none found
    const names = r.schools.map(schoolName); // schools offering this degree
    const offered = names.length ? names.slice(0, 4).join(', ') + (names.length > 4 ? ` +${names.length - 4} more` : '') : 'No indexed Davao campus yet'; // school text
    return `<div class="match"><div class="rank">${i + 1}</div><div><h3>${esc(r.name)}</h3><p class="muted small">${esc(r.career)}</p><div class="bar"><i style="width:${r.pct}%"></i></div><p class="small"><span class="${r.meetsAvg ? 'ok' : 'warn'}">Grades: ${r.meetsAvg ? 'meets' : 'below'} ${r.minAvg} avg</span> &nbsp; <span class="${r.meetsEncae ? 'ok' : 'warn'}">ENCAE: ${r.meetsEncae ? 'meets' : 'below'} PR ${r.minEncae}</span></p><div class="crumbs">${crumbs}</div><p class="small muted">Offered at: ${esc(offered)}</p><p class="why small" data-why="${esc(r.id)}">Writing AI explanation...</p></div><div class="pct">${r.pct}%</div></div>`; // card HTML
  }).join('')}</div>`; // end list
} // end renderResults
async function loadExplanations(id) { // fetch the AI "why" sentences after the results are shown
  try { // call the server
    const data = await api('/explain', { method: 'POST', body: JSON.stringify({ id }) }); // ask for sentences
    if (state.resultsId !== id) return; // a newer assessment (or a loaded record) replaced these results
    $$('[data-why]').forEach((el) => { // each placeholder
      const text = data.why && data.why[el.dataset.why]; // sentence for this degree
      if (text) el.textContent = text; else el.remove(); // show it or remove the placeholder
    }); // end loop
  } catch (e) { $$('[data-why]').forEach((el) => el.remove()); } // AI unavailable: just remove the placeholders
} // end loadExplanations

// ---------- map and nearby campuses (Davao only) ----------
function haversine(a, b) { // distance in km between two coordinates
  const R = 6371, rad = (d) => (d * Math.PI) / 180; // earth radius and degree converter
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng); // differences in radians
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2; // haversine formula
  return 2 * R * Math.asin(Math.sqrt(h)); // distance in km
} // end haversine
function nearbyCampuses() { // the 5 nearest campuses (only schools offering a matched degree after an assessment)
  const ref = state.userPos && inDavao(state.userPos) ? state.userPos : { lat: DAVAO_CENTER[0], lng: DAVAO_CENTER[1] }; // user, or city centre if outside Davao
  const ids = state.results ? new Set(state.results.flatMap((r) => r.schools)) : null; // schools offering matched degrees
  let pool = state.schools.filter((s) => !ids || ids.has(s.id)); // schools offering matched degrees
  if (ids && !pool.length) pool = state.schools; // none indexed for these degrees yet: show the nearest campuses instead of nothing
  return pool.map((s) => ({ // attach distance and programs
    ...s, // keep school fields
    km: haversine(ref, s), // distance from reference point
    offered: state.results ? state.results.filter((d) => d.schools.includes(s.id)).map((d) => d.name.replace(/^(BS|AB) /, '')) : s.programs.slice(0, 2).map((n) => n.replace(/^(BS|AB) /, '')) // matched degrees, or first two programs
  })).sort((a, b) => a.km - b.km).slice(0, 5); // nearest five
} // end nearbyCampuses
function renderCampuses(fit = true) { // redraw list and map markers
  const list = nearbyCampuses(); // campuses to show
  $('#campusCount').textContent = `${list.length} Locations`; // count label
  $('#locStatus').textContent = state.locStatus; // location pill
  $('#campusList').innerHTML = list.length ? list.map((c, i) => `<div class="campus ${i === 0 ? 'hl' : ''}" data-cid="${esc(c.id)}"><div><b>${esc(c.name)}</b>${state.results ? `<span class="tag">Top ${i + 1}</span>` : ''}<p class="muted small">${esc(c.address)}</p><p class="small">${esc(c.offered.join(', ') || c.kind)} &middot; ~${c.km.toFixed(1)} km</p></div><a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}">Directions</a></div>`).join('') : '<p class="muted small">No indexed campuses yet. Run the indexer (see README).</p>'; // campus cards or hint
  if (!state.map) return; // map not ready yet
  state.allLayer.clearLayers(); state.topLayer.clearLayers(); // remove old markers
  state.schools.forEach((s) => L.circleMarker([s.lat, s.lng], { radius: 5, color: '#64748b', weight: 1, fillColor: '#94a3b8', fillOpacity: .9 }).bindPopup(`<b>${esc(s.name)}</b><br>${esc(s.address)}`).addTo(state.allLayer)); // small grey pin for every school
  list.forEach((c, i) => L.circleMarker([c.lat, c.lng], { radius: 12, color: '#b91c1c', weight: 2, fillColor: '#ef4444', fillOpacity: .95 }).bindPopup(`<b>${esc(c.name)}</b><br>${c.km.toFixed(1)} km away`).bindTooltip(String(i + 1), { permanent: true, direction: 'center', className: 'pin-num' }).addTo(state.topLayer)); // numbered red pin for the top five
  if (state.userPos) L.circleMarker([state.userPos.lat, state.userPos.lng], { radius: 8, color: '#1d4ed8', fillColor: '#3b82f6', fillOpacity: 1 }).bindPopup('You are here').addTo(state.topLayer); // blue dot for the user
  if (!fit) return; // keep the current view (used while GPS updates)
  const pts = list.map((c) => [c.lat, c.lng]).concat(state.userPos && inDavao(state.userPos) ? [[state.userPos.lat, state.userPos.lng]] : []); // points to fit
  if (pts.length) state.map.fitBounds(pts, { padding: [30, 30], maxZoom: 14 }); // zoom to show them
} // end renderCampuses
function initMap() { // create the Davao-only map once
  state.map = L.map('map', { maxBounds: DAVAO_BOUNDS, maxBoundsViscosity: 1, minZoom: 10 }).setView(DAVAO_CENTER, 12); // cannot pan outside Davao
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: 'abcd', maxZoom: 19 }).addTo(state.map); // clean light map style
  state.allLayer = L.layerGroup().addTo(state.map); // group for all-school pins
  state.topLayer = L.layerGroup().addTo(state.map); // group for top-5 pins and the user
  if (!navigator.geolocation) { state.locStatus = 'Location not supported - using Davao City centre'; return; } // old browser
  navigator.geolocation.watchPosition((p) => { // keep tracking the user's position
    const pos = { lat: p.coords.latitude, lng: p.coords.longitude }; // new position
    if (state.userPos && haversine(state.userPos, pos) < 0.2) return; // ignore moves under 200 m
    state.userPos = pos; // save it
    state.locStatus = inDavao(pos) ? 'Tracking your location' : 'You are outside Davao - using city centre'; // status text
    renderCampuses(!state.located); // zoom only on the first fix
    state.located = true; // later updates keep the view
  }, (err) => { // permission denied or unavailable
    if (err.code !== 1) return; // timeouts and temporary GPS gaps are retried by watchPosition; do not nag
    state.locStatus = 'Location off - using Davao City centre'; // status text
    renderCampuses(false); // refresh the pill
    toast('Location blocked. Distances are measured from Davao City centre.'); // tell the user
  }, { enableHighAccuracy: false, maximumAge: 10000, timeout: 15000 }); // GPS options
} // end initMap

// ---------- submit ----------
async function submitAssessment() { // send grades to the server, show and save the result
  const err = validation(); // check inputs
  if (err) { updateReady(); toast(err); return; } // stop if invalid
  const btn = $('#submitBtn'); // the submit button
  btn.disabled = true; btn.textContent = 'Analyzing...'; // prevent double clicks
  try { // call the server
    const rec = await api('/analyze', { method: 'POST', body: JSON.stringify({ g11: state.g11, g12: state.g12, encae: Number($('#encae').value) }) }); // score + save
    state.results = rec.results; // top 5 matches
    state.history.unshift(rec); // newest first
    state.selectedId = rec.id; // select it in history
    state.resultsId = rec.id; // these are the results on screen
    renderResults(state.results); // show matches
    renderCampuses(); // update nearby campuses to matched schools
    renderHistory(); // refresh history tab
    toast('Assessment saved to History.'); // confirm
    loadExplanations(rec.id); // fill in the AI sentences in the background
  } catch (e) { toast(e.message); } // show the problem
  finally { btn.disabled = false; btn.textContent = 'Submit & Analyze Assessment'; } // restore the button
} // end submitAssessment

// ---------- history ----------
function filteredHistory() { // apply search and tier filter
  const q = $('#search').value.trim().toLowerCase(); // search text
  const tier = $('#tier').value; // chosen tier
  return state.history.filter((r) => { // keep matching records
    const hay = [r.dateLabel, ...r.results.map((x) => x.name), ...r.g11.concat(r.g12).map((s) => s.name)].join(' ').toLowerCase(); // searchable text
    return (!q || hay.includes(q)) && (tier === 'all' || tierOf(r.results[0].pct) === tier); // both filters
  }); // end filter
} // end filteredHistory
function renderHistory() { // draw table, counters and detail
  const rows = filteredHistory(); // visible records
  $('#historyBadge').textContent = state.history.length; // sidebar badge
  $('#recCount').textContent = `${state.history.length} Records`; // header counter
  $('#showing').textContent = `Showing ${rows.length} recorded historical assessment${rows.length === 1 ? '' : 's'}`; // footer text
  $('#historyEmpty').hidden = rows.length > 0; // show empty state only when no rows
  $('#historyBody').innerHTML = rows.map((r) => `<tr class="row ${r.id === state.selectedId ? 'sel' : ''}" data-id="${esc(r.id)}"><td>${r.g11.length + r.g12.length} subjects</td><td>PR ${r.encae}</td><td>${esc(r.dateLabel)}</td><td><b>${esc(r.results[0].name)}</b> <span class="pill blue">${r.results[0].pct}%</span></td><td class="right actions-col"><button class="x" data-rm="${esc(r.id)}" aria-label="Delete record">&times;</button></td></tr>`).join(''); // table rows
  renderDetail(); // refresh detail card
} // end renderHistory
function renderDetail() { // show the selected snapshot
  const r = state.history.find((x) => x.id === state.selectedId); // selected record
  $('#loadBtn').disabled = !r; // enable load button only with a selection
  $('#selLabel').textContent = r ? `${r.dateLabel} (${r.results[0].name})` : 'None'; // label (textContent is safe)
  if (!r) { $('#detail').className = 'empty dashed'; $('#detail').innerHTML = '<div class="empty-icon">&#128203;</div><h4>No Snapshot Selected</h4><p class="muted">Historical snapshots will appear here once an assessment record is selected or submitted.</p>'; return; } // empty state
  const col = (t, a) => `<div><h4>${t}</h4>${a.map((s) => `<p>${esc(s.name)} <span class="type ${s.type}">${s.type}</span> <b>${s.grade}</b></p>`).join('')}</div>`; // one subject column
  $('#detail').className = ''; // remove empty styling
  $('#detail').innerHTML = `<div class="detail-grid">${col('Grade 11', r.g11)}${col('Grade 12', r.g12)}</div><h4 style="margin-top:16px">Top 5 matches (ENCAE PR ${r.encae})</h4>${r.results.map((x, i) => `<p>${i + 1}. ${esc(x.name)} &ndash; <b>${x.pct}%</b></p>`).join('')}`; // snapshot content
} // end renderDetail
function exportCsv() { // download history as CSV
  if (!state.history.length) { toast('No records to export yet.'); return; } // nothing to export
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`; // quote a CSV cell
  const lines = [['Date', 'Subjects Added', 'ENCAE PR', 'Best Match', 'Match %', 'Top 5'].map(q).join(',')]; // header row
  state.history.forEach((r) => lines.push([r.dateLabel, r.g11.length + r.g12.length, r.encae, r.results[0].name, r.results[0].pct, r.results.map((x) => `${x.name} (${x.pct}%)`).join('; ')].map(q).join(','))); // data rows
  const a = document.createElement('a'); // temporary link
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); // file from text
  a.download = 'nextstep-history.csv'; // file name
  a.click(); // start download
} // end exportCsv

// ---------- navigation ----------
function show(view) { // switch between views
  $$('.view').forEach((v) => (v.hidden = v.id !== 'view-' + view)); // show one view
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view)); // highlight nav button
  if (view === 'assessment' && state.map) setTimeout(() => state.map.invalidateSize(), 50); // fix map size after being hidden
} // end show

// ---------- event wiring ----------
document.addEventListener('click', async (e) => { // one listener for all clicks
  const t = e.target; // clicked element
  if (t.dataset.view) show(t.dataset.view); // nav buttons
  if (t.closest('[data-view]') && !t.dataset.view) show(t.closest('[data-view]').dataset.view); // badge inside nav button
  if (t.dataset.go) show(t.dataset.go); // "start assessment" buttons
  if (t.dataset.add) openDialog(Number(t.dataset.add)); // add-subject buttons
  if (t.dataset.del) { const [l, i] = t.dataset.del.split(':'); state['g' + l].splice(Number(i), 1); renderSubjects(); } // remove a subject
  if (t.dataset.rm) { // delete a record
    try { await api('/assessments/' + encodeURIComponent(t.dataset.rm), { method: 'DELETE' }); } catch (err) { toast(err.message); return; } // delete on the server
    state.history = state.history.filter((r) => r.id !== t.dataset.rm); // remove locally
    if (state.selectedId === t.dataset.rm) state.selectedId = null; // clear selection
    renderHistory(); // redraw
    return; // do not also select the row
  } // end delete
  const row = t.closest('tr.row'); // history row clicked?
  if (row) { state.selectedId = row.dataset.id; renderHistory(); } // select it
  const camp = t.closest('.campus'); // campus card clicked?
  if (camp && !t.closest('a') && state.map) { const c = state.schools.find((s) => s.id === camp.dataset.cid); if (c) state.map.setView([c.lat, c.lng], 15); } // zoom to campus
}); // end click listener
$('#dlgSave').addEventListener('click', saveSubject); // save subject
$('#dlgCancel').addEventListener('click', () => $('#subjectDialog').close()); // cancel dialog
$('#subName').addEventListener('input', onNameInput); // auto-detect classification while typing
$('#subType').addEventListener('change', () => { state.typeTouched = true; }); // remember a manual choice
$('#encae').addEventListener('input', updateReady); // re-check on ENCAE typing
$('#submitBtn').addEventListener('click', submitAssessment); // run analysis
$('#search').addEventListener('input', renderHistory); // live search
$('#tier').addEventListener('change', renderHistory); // tier filter
$('#exportCsv').addEventListener('click', exportCsv); // CSV export
$('#printPdf').addEventListener('click', () => { show('history'); window.print(); }); // print / save as PDF
$('#loadBtn').addEventListener('click', () => { // load a past record into the evaluator
  const r = state.history.find((x) => x.id === state.selectedId); // selected record
  if (!r) return; // nothing selected
  state.g11 = r.g11.map((s) => ({ ...s })); state.g12 = r.g12.map((s) => ({ ...s })); // copy subjects
  $('#encae').value = r.encae; // restore ENCAE
  state.results = null; state.resultsId = null; // clear old results
  $('#results').innerHTML = '<div class="empty dashed"><div class="empty-icon amber">&#9719;</div><h4>Assessment Pending</h4><p class="muted">Review the loaded subjects, then click "Submit &amp; Analyze Assessment".</p></div>'; // pending state
  renderSubjects(); renderCampuses(); show('assessment'); // refresh and switch
}); // end load listener

// ---------- start-up ----------
(async function init() { // runs once on page load
  $('#assessDate').value = todayLabel(); // auto-record today's date (Philippine time)
  renderSubjects(); // draw empty tables
  renderHistory(); // draw empty history
  initMap(); // start the Davao map and location tracking
  try { // load everything from the server
    const [subs, schools, hist] = await Promise.all([api('/subjects'), api('/schools'), api('/assessments')]); // three requests at once
    subs.subjects.forEach((s) => { state.catalog[s.name.toLowerCase()] = s.type; }); // lookup table for instant classification
    $('#subjectList').innerHTML = subs.subjects.map((s) => `<option value="${esc(s.name)}"></option>`).join(''); // fill the suggestion list (typing anything else is still allowed)
    state.schools = schools.schools; // schools with pins
    state.history = hist.assessments; // saved assessments
    renderCampuses(true); // draw pins and list, and zoom to them (GPS may have answered before the schools loaded)
    renderHistory(); // draw history
  } catch (e) { toast('Cannot reach the NextStep server. Run: python backend/server.py'); } // backend not running
})(); // end init
