// ============ VoteMode App ============

const COLORS = {
  red: '#A83232', redSoft: '#C97B6E',
  blue: '#1F5C8B', blueSoft: '#6FA0BF',
  green: '#3B6D11', greenSoft: '#8FAE6B',
  amber: '#9C7A1F', grey: '#8C8B82'
};

const NO_RACE_COLOR = '#666861';

const RACES = {
  president: { label: 'President', adjective: 'presidential' },
  senate: { label: 'Senate', adjective: 'Senate' },
  governor: { label: 'Governor', adjective: 'governor' }
};

const COMPLETENESS_COLOR = {
  C6: '#2F5C0E', C5: '#3B6D11', C4: '#5C8A2A', C3: '#7FA84D',
  C2: '#A8B97B', C1: '#C7C8A8',
  U: '#B8B6AB', F: '#D9534F', UNKNOWN: '#D9D7CC'
};

const STATE_NAME_TO_ABBR = {
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA','Colorado':'CO',
  'Connecticut':'CT','Delaware':'DE','District of Columbia':'DC','Florida':'FL','Georgia':'GA',
  'Hawaii':'HI','Idaho':'ID','Illinois':'IL','Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY',
  'Louisiana':'LA','Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN',
  'Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV','New Hampshire':'NH',
  'New Jersey':'NJ','New Mexico':'NM','New York':'NY','North Carolina':'NC','North Dakota':'ND',
  'Ohio':'OH','Oklahoma':'OK','Oregon':'OR','Pennsylvania':'PA','Rhode Island':'RI',
  'South Carolina':'SC','South Dakota':'SD','Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT',
  'Virginia':'VA','Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY'
};

// Non-geographic reporting units shown as a floating pill at the bottom of the
// map (like AK's overseas house district) rather than as a polygon.
const FLOATING_UNITS = {
  AK: { id: 'hd99_fed_overseas_absentee', label: 'Federal overseas absentee (HD99)' },
  ME: { id: 'state_uocava', label: 'State UOCAVA (overseas & military ballots)' },
  RI: { id: 'federal', label: 'Federal ballots (overseas & military, UOCAVA)' }
};

const MODE_LABELS = {
  election_day: 'Election day',
  early_in_person: 'Early in-person',
  mail: 'Mail / absentee',
  pre_election_day: 'Pre-election day',
  late_pre_election_day: 'Late pre-election day',
  late_mail: 'Late mail',
  election_day_and_mail: 'Election day and mail',
  provisional: 'Provisional',
  overseas: 'Overseas',
  affidavit: 'Affidavit',
  in_person: 'In-person',
  unallocated: 'Unallocated',
  total: 'Total'
};

// ---- App state ----
const state = {
  view: 'national',       // 'national' | 'state'
  race: 'president',
  currentContest: 'regular',
  currentStateAbbr: null,
  selectedUnitId: null,
  colorMode: 'coverage',   // 'results' | 'coverage' — opens on coverage
  numberMode: 'votes',     // 'votes' | 'percent' — modal breakdown table display
  cityLabels: null,        // data/geo/city_labels.json, loaded once on demand
  national: null,
  nationalCache: {},      // race -> parsed national JSON
  geoStates: null,
  stateDataCache: {},      // race:abbr:contest -> parsed state JSON
  geoCache: {},            // abbr -> topojson
  renderToken: 0           // bumped on every navigation; async work checks this before painting
};

const svg = d3.select('#mapSvg');
const tooltip = document.getElementById('mapTooltip');
const mapArea = document.getElementById('mapArea');

// ============ MAP LAYOUT / ZOOM ============
// Uniform breathing-room margin on every side. The map is centered relative to
// the full map-area box — the legend floats on top of whatever empty beige
// space is left over rather than carving out its own reserved region, so
// centering never has to compromise for it.
const MAP_MARGIN = 16;

function getFitExtent(w, h) {
  return [
    [MAP_MARGIN, MAP_MARGIN],
    [w - MAP_MARGIN, h - MAP_MARGIN]
  ];
}

// Reads the real, current on-screen boxes of the four floating map overlays
// (title, hint, back button, legend — plus the AK overseas marker) in
// mapArea-local pixel coordinates, skipping any that are currently hidden.
function getOverlayRectsForFit() {
  const areaRect = mapArea.getBoundingClientRect();
  function localRect(el) {
    if (!el) return null;
    if (window.getComputedStyle(el).display === 'none') return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return {
      left: r.left - areaRect.left,
      top: r.top - areaRect.top,
      right: r.right - areaRect.left,
      bottom: r.bottom - areaRect.top
    };
  }
  return [
    localRect(document.getElementById('mapTitleOverlay')),
    localRect(document.getElementById('mapHint')),
    localRect(document.getElementById('backBtn')),
    localRect(document.getElementById('mapLegend')),
    localRect(document.getElementById('overseasMarker'))
  ].filter(Boolean);
}

// Fits `geo` into `extent` at full size first (same as a plain fitExtent). If the
// resulting shape doesn't come close to any of the floating overlays, that's used
// as-is — most states (anything taller than it is wide, e.g. CA/NJ/NV/IL) clear
// the corners naturally and never get touched. Only when the full-size fit actually
// overlaps (or sits right up against) one of the overlays do we uniformly scale the
// map down — recentering on the box each step — until there's a small gap on every
// side that matters, rather than always reserving dead space for the worst case.
function fitProjectionAvoidingOverlays(makeProjection, geo, extent) {
  const boxCenter = [(extent[0][0] + extent[1][0]) / 2, (extent[0][1] + extent[1][1]) / 2];
  const projection = makeProjection().fitExtent(extent, geo);
  const path = d3.geoPath(projection);
  const baseScale = projection.scale();
  const baseTranslate = projection.translate();
  const overlays = getOverlayRectsForFit();
  const BUFFER = 10; // px of breathing room once cleared

  function overlaps(bbox) {
    return overlays.some(r =>
      !(bbox[1][0] + BUFFER < r.left || bbox[0][0] - BUFFER > r.right ||
        bbox[1][1] + BUFFER < r.top || bbox[0][1] - BUFFER > r.bottom)
    );
  }

  function applyScale(f) {
    projection.scale(baseScale * f).translate(baseTranslate);
    const b0 = path.bounds(geo);
    const cx = (b0[0][0] + b0[1][0]) / 2, cy = (b0[0][1] + b0[1][1]) / 2;
    const t = projection.translate();
    projection.translate([t[0] + (boxCenter[0] - cx), t[1] + (boxCenter[1] - cy)]);
    return path.bounds(geo);
  }

  const fullBbox = applyScale(1);
  if (!overlays.length || !overlaps(fullBbox)) return projection; // fast path: no shrink needed

  const MIN_SCALE = 0.35; // don't let a pathological case shrink the map to nothing
  const minBbox = applyScale(MIN_SCALE);
  if (overlaps(minBbox)) return projection; // best effort — still at MIN_SCALE, nothing more to do

  let lo = MIN_SCALE, hi = 1;
  for (let i = 0; i < 16; i++) {
    const mid = (lo + hi) / 2;
    const b = applyScale(mid);
    if (overlaps(b)) hi = mid; else lo = mid;
  }
  applyScale(lo);
  return projection;
}

let zoomBehavior = null;
function setupZoom() {
  zoomBehavior = d3.zoom()
    .scaleExtent([1, 14])
    .on('zoom', (event) => {
      svg.select('g.zoom-layer').attr('transform', event.transform);
      // Counter-scale city labels so they stay a constant size on screen.
      svg.selectAll('g.city').attr('transform', d =>
        `translate(${d.px},${d.py}) scale(${1 / event.transform.k})`);
    });
  svg.call(zoomBehavior);
}
function resetZoom() {
  if (zoomBehavior) svg.call(zoomBehavior.transform, d3.zoomIdentity);
}

// ============ DATA LOADING ============

// Bump this whenever the data files are rebuilt. It busts visitors' HTTP cache
// (every request carries ?v=...) while still letting browsers cache normally
// between builds.
const DATA_VERSION = '2026-08-15-races';

async function loadJSON(path) {
  const url = path + (path.includes('?') ? '&' : '?') + 'v=' + DATA_VERSION;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to load ' + path);
  return res.json();
}

async function init() {
  state.national = await ensureNationalData(state.race);
  state.geoStates = await loadJSON('data/geo/us_states.json');
  setupZoom();
  renderNationalView();
  setupSearch();
  setupViewToggle();
  setupBackButton();
  setupOverseasMarker();
  setupDownloads();
}

async function ensureNationalData(race) {
  if (!state.nationalCache[race]) {
    state.nationalCache[race] = await loadJSON(`data/races/${race}/national.json`);
  }
  return state.nationalCache[race];
}

function stateDataKey(abbr, contest = state.currentContest) {
  return `${state.race}:${abbr}:${contest}`;
}

function currentStateData() {
  if (!state.currentStateAbbr) return null;
  return state.stateDataCache[stateDataKey(state.currentStateAbbr)] || null;
}

async function ensureStateData(abbr, contest = state.currentContest) {
  const lower = abbr.toLowerCase();
  const key = stateDataKey(abbr, contest);
  if (!state.stateDataCache[key]) {
    const suffix = contest === 'special' ? '_special' : '';
    try {
      state.stateDataCache[key] = await loadJSON(`data/races/${state.race}/states/${lower}${suffix}.json`);
    } catch (e) {
      state.stateDataCache[key] = null;
    }
  }
  if (state.stateDataCache[key] && !state.geoCache[abbr]) {
    try {
      state.geoCache[abbr] = await loadJSON(`data/geo/${stateGeoFile(abbr)}`);
    } catch (e) {
      state.geoCache[abbr] = null; // no geometry built for this state yet in the prototype
    }
  }
  return state.stateDataCache[key];
}

function stateGeoFile(abbr) {
  // Maps abbreviation to the geometry filename convention used across our build scripts
  const neMap = { CT:'ct', ME:'me', MA:'ma', NH:'nh', RI:'ri', VT:'vt' };
  if (abbr === 'AK') return 'alaska/ak_districts_topo.json';
  if (abbr === 'DC') return 'dc/dc_wards_topo.json';
  if (neMap[abbr]) return `new_england/${neMap[abbr]}_towns_topo.json`;
  return `${abbr.toLowerCase()}_counties.json`; // built per-state on demand from us-atlas in this prototype
}

// ============ COLOR LOGIC ============

function marginColor(pctD, pctR) {
  const margin = pctR - pctD; // positive = R lean
  const intensity = Math.min(Math.abs(margin) / 40, 1); // saturate by 40-pt margin
  const base = margin >= 0 ? COLORS.red : COLORS.blue;
  const soft = margin >= 0 ? COLORS.redSoft : COLORS.blueSoft;
  return d3.interpolateRgb(soft, base)(intensity);
}

function coverageColor(code) {
  return COMPLETENESS_COLOR[code] || COMPLETENESS_COLOR.UNKNOWN;
}

// National coverage fill for one state. Uses the precomputed `cov` field:
// { mode:'solid', g:'C5' } for states whose units share one grade, or
// { mode:'stripe', g:['C3','C2'] } for mixed states — drawn as diagonal
// two-color stripes of the two most common grades (floating overseas/UOCAVA
// units are excluded from that calculation upstream).
function nationalCoverageFill(s) {
  const cov = s.cov;
  if (!cov) return coverageColor(s.avg_completeness);
  if (cov.mode === 'solid') return coverageColor(cov.g);
  const key = cov.g[0] + '_' + cov.g[1];
  const pid = 'covstripe-' + key;
  if (svg.select('#' + pid).empty()) {
    let defs = svg.select('defs');
    if (defs.empty()) defs = svg.insert('defs', ':first-child');
    const p = defs.append('pattern')
      .attr('id', pid).attr('width', 12).attr('height', 12)
      .attr('patternUnits', 'userSpaceOnUse').attr('patternTransform', 'rotate(45)');
    p.append('rect').attr('width', 12).attr('height', 12).attr('fill', coverageColor(cov.g[0]));
    p.append('rect').attr('width', 6).attr('height', 12).attr('fill', coverageColor(cov.g[1]));
  }
  return 'url(#' + pid + ')';
}

// Fill for a whole state on the national map, honoring the current color mode.
function nationalFill(s) {
  if (!s) return NO_RACE_COLOR;
  return state.colorMode === 'coverage' ? nationalCoverageFill(s) : marginColor(s.pct_D, s.pct_R);
}

function unitColor(unit, mode) {
  if (mode === 'coverage') {
    return coverageColor(unit.completeness || unit.avg_completeness || 'UNKNOWN');
  }
  return marginColor(unit.pct_D, unit.pct_R);
}

function unitKeyForFeature(data, featureId) {
  return data.geometry_aliases?.[featureId] || featureId;
}

function unitForFeature(data, featureId) {
  return data.units[unitKeyForFeature(data, featureId)];
}

function raceLabel() {
  return RACES[state.race].label;
}

function shortCandidate(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (!parts.length) return 'Candidate';
  const suffixes = new Set(['Jr.', 'Sr.', 'II', 'III', 'IV']);
  const index = suffixes.has(parts[parts.length - 1]) ? parts.length - 2 : parts.length - 1;
  return parts[Math.max(index, 0)];
}

function renderMapTitle(stateName = null) {
  const el = document.getElementById('mapTitleOverlay');
  const raceOptions = Object.entries(RACES).map(([key, race]) =>
    `<option value="${key}" ${key === state.race ? 'selected' : ''}>2024 ${race.label}</option>`
  ).join('');
  const stateSummary = stateName && state.currentStateAbbr
    ? state.national.states[state.currentStateAbbr]
    : null;
  const contests = stateSummary?.contests || [];
  const contestSelect = contests.length > 1 ? `
    <span class="map-title-separator">·</span>
    <select class="contest-select" id="contestSelect" aria-label="Choose Senate contest">
      ${contests.map(contest => `<option value="${contest.key}" ${contest.key === state.currentContest ? 'selected' : ''}>${contest.label}</option>`).join('')}
    </select>` : '';

  el.innerHTML = `
    <select class="race-select" id="raceSelect" aria-label="Choose 2024 race">${raceOptions}</select>
    ${stateName ? `<span class="map-title-separator">·</span><span>${stateName}</span>` : ''}
    ${contestSelect}
  `;
  document.getElementById('raceSelect').addEventListener('change', event => setRace(event.target.value));
  document.getElementById('contestSelect')?.addEventListener('change', event => switchContest(event.target.value));
}

async function setRace(race) {
  if (!RACES[race] || race === state.race) return;
  state.renderToken++;
  hideTooltip();
  const national = await ensureNationalData(race);
  state.race = race;
  state.national = national;
  state.currentContest = 'regular';
  renderNationalView();
}

function switchContest(contest) {
  if (contest === state.currentContest || !state.currentStateAbbr) return;
  state.currentContest = contest;
  enterState(state.currentStateAbbr);
}

// ============ NATIONAL VIEW ============

function renderNationalView() {
  state.renderToken++; // invalidate any in-flight enterState() call
  state.view = 'national';
  state.currentStateAbbr = null;
  state.currentContest = 'regular';
  state.selectedUnitId = null;
  removeCoverageStrip();

  renderMapTitle();
  document.getElementById('mapHint').textContent = 'Click a state to explore · scroll to zoom';
  document.getElementById('overseasMarker').classList.remove('visible');
  document.getElementById('overseasMarker').classList.remove('active');
  updateBreadcrumb();
  updateBackButton();
  renderLegend();

  const geo = topojson.feature(state.geoStates, state.geoStates.objects.states);
  const extent = getFitExtent(mapArea.clientWidth, mapArea.clientHeight);
  const projection = fitProjectionAvoidingOverlays(() => d3.geoAlbersUsa(), geo, extent);
  const path = d3.geoPath(projection);

  svg.attr('viewBox', `0 0 ${mapArea.clientWidth} ${mapArea.clientHeight}`);
  svg.selectAll('*').remove();
  resetZoom();
  const gLayer = svg.append('g').attr('class', 'zoom-layer');

  gLayer.selectAll('path.map-unit')
    .data(geo.features)
    .join('path')
    .attr('class', 'map-unit')
    .classed('no-race', d => !state.national.states[STATE_NAME_TO_ABBR[d.properties.name]])
    .attr('d', path)
    .attr('fill', d => nationalFill(state.national.states[STATE_NAME_TO_ABBR[d.properties.name]]))
    .on('mousemove', (event, d) => showTooltipNational(event, d))
    .on('mouseleave', hideTooltip)
    .on('click', (event, d) => {
      const abbr = STATE_NAME_TO_ABBR[d.properties.name];
      if (abbr && state.national.states[abbr]) enterState(abbr);
    });

  renderNationalPanel();
  updateSearchPlaceholder();
}

function showTooltipNational(event, d) {
  const abbr = STATE_NAME_TO_ABBR[d.properties.name];
  const s = state.national.states[abbr];
  if (!s) {
    tooltip.innerHTML = `
      <div class="tt-name">${d.properties.name}</div>
      <div class="tt-hint no-rule">No 2024 ${RACES[state.race].adjective} race</div>
    `;
    positionTooltip(event);
    return;
  }
  const candidateR = shortCandidate(s.candidate_R);
  const candidateD = shortCandidate(s.candidate_D);
  const contestHint = s.contests?.length > 1 ? ` · ${s.contests.length} contests` : '';
  tooltip.innerHTML = `
    <div class="tt-name">${d.properties.name}</div>
    <div class="tt-row"><span class="tt-cand" style="color:${COLORS.red}">${candidateR}</span><span class="tt-val">${fmtNum(s.votes_R)} · ${fmtPct(s.pct_R)}%</span></div>
    <div class="tt-row"><span class="tt-cand" style="color:${COLORS.blue}">${candidateD}</span><span class="tt-val">${fmtNum(s.votes_D)} · ${fmtPct(s.pct_D)}%</span></div>
    <div class="tt-hint">Avg. data quality: ${s.avg_completeness}${contestHint} · Click to explore</div>
  `;
  positionTooltip(event);
}

function positionTooltip(event) {
  const rect = mapArea.getBoundingClientRect();
  const OFFSET = 14;
  const cx = event.clientX - rect.left;
  const cy = event.clientY - rect.top;

  // Make it visible first so offsetWidth/Height reflect the real rendered size
  // (innerHTML is already set by the caller at this point).
  tooltip.classList.add('visible');
  const tw = tooltip.offsetWidth;
  const th = tooltip.offsetHeight;

  // Default: below-right of the cursor. If that would run past the right or
  // bottom edge of the map area, flip to the opposite side of the cursor
  // instead of letting the box get squished against the edge.
  let x = cx + OFFSET;
  if (x + tw > rect.width) x = cx - OFFSET - tw;
  let y = cy + OFFSET;
  if (y + th > rect.height) y = cy - OFFSET - th;

  // Last-resort clamp (tiny windows): keep it inside the map area.
  x = Math.max(4, Math.min(x, rect.width - tw - 4));
  y = Math.max(4, Math.min(y, rect.height - th - 4));

  tooltip.style.left = x + 'px';
  tooltip.style.top = y + 'px';
}
function hideTooltip() { tooltip.classList.remove('visible'); }

// ============ STATE VIEW ============

async function enterState(abbr) {
  const myToken = ++state.renderToken; // this navigation "owns" this token
  const data = await ensureStateData(abbr);
  if (myToken !== state.renderToken) return; // a newer navigation started while we were fetching; abandon this one

  state.view = 'state';
  state.currentStateAbbr = abbr;
  state.selectedUnitId = null;

  if (!data) {
    // No data file built for this state yet in the prototype
    removeCoverageStrip();
    const stateName = Object.keys(STATE_NAME_TO_ABBR).find(n => STATE_NAME_TO_ABBR[n] === abbr) || abbr;
    renderMapTitle(stateName);
    svg.selectAll('*').remove();
    svg.append('text')
      .attr('x', mapArea.clientWidth / 2).attr('y', mapArea.clientHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('font-family', 'Inter').attr('font-size', 14).attr('fill', '#8C8B82')
      .text(`${stateName} isn't wired up in this prototype yet`);
    setPanelHeader('State profile', stateName, '');
    document.getElementById('panelContent').innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
        <div class="empty-state-title">No data yet</div>
        <div class="empty-state-sub">${stateName}'s data file hasn't been added to this prototype build. Try Alabama, Alaska, DC, or one of the New England states.</div>
      </div>
    `;
    updateBreadcrumbForMissingState(stateName);
    updateBackButton();
    updateSearchPlaceholder();
    return;
  }

  renderMapTitle(data.state);
  document.getElementById('mapHint').textContent = `Click a ${unitTypeLabel(data.unit_type, false)} to inspect · scroll to zoom`;
  updateBreadcrumb();
  updateBackButton();
  renderLegend();
  renderStatePanel(data);

  const overseasMarkerEl = document.getElementById('overseasMarker');
  overseasMarkerEl.classList.remove('active');
  const floating = FLOATING_UNITS[abbr];
  const floatingUnit = floating ? data.units[floating.id] : null;
  if (floatingUnit) {
    overseasMarkerEl.classList.add('visible');
    overseasMarkerEl.dataset.unitId = floating.id;
    document.getElementById('overseasLabel').textContent = floating.label;
    const c = marginColor(floatingUnit.pct_D, floatingUnit.pct_R);
    overseasMarkerEl.style.borderColor = c;
    const dot = overseasMarkerEl.querySelector('.overseas-dot');
    if (dot) dot.style.background = c;
  } else {
    overseasMarkerEl.classList.remove('visible');
    delete overseasMarkerEl.dataset.unitId;
  }

  const geoTopo = state.geoCache[abbr];
  svg.selectAll('*').remove();
  resetZoom();
  const gLayer = svg.append('g').attr('class', 'zoom-layer');

  if (!geoTopo) {
    // Geometry not yet built for this state in the prototype
    gLayer.append('text')
      .attr('x', mapArea.clientWidth / 2).attr('y', mapArea.clientHeight / 2)
      .attr('text-anchor', 'middle')
      .attr('font-family', 'Inter').attr('font-size', 14).attr('fill', '#8C8B82')
      .text(`County geometry for ${data.state} not yet built in this prototype`);
    updateSearchPlaceholder();
    return;
  }

  const objKey = Object.keys(geoTopo.objects)[0];
  const geo = topojson.feature(geoTopo, geoTopo.objects[objKey]);

  const stateName = data.state;
  const stateOutlineFeature = topojson.feature(state.geoStates, state.geoStates.objects.states)
    .features.find(f => f.properties.name === stateName);

  // Fit bounds to the authoritative Census state outline (plus the county/town/ward
  // polygons) rather than the unit polygons alone — some states (Maine's northern tip,
  // for instance) have land that isn't covered by any individual town polygon in this
  // prototype's geometry, so fitting to units-only crops the map at the wrong edge.
  const fitGeo = stateOutlineFeature
    ? { type: 'FeatureCollection', features: [stateOutlineFeature, ...geo.features] }
    : geo;

  const extent = getFitExtent(mapArea.clientWidth, mapArea.clientHeight);
  let proj;
  if (abbr === 'AK') {
    // Alaska crosses the antimeridian — rotate central meridian to avoid the wrap.
    proj = fitProjectionAvoidingOverlays(() => d3.geoMercator().rotate([154, 0]), fitGeo, extent);
  } else {
    // All other states (including DC's wards, now that their ring winding is fixed)
    // fit on the actual geometry works correctly and produces the right scale/translate.
    proj = fitProjectionAvoidingOverlays(() => d3.geoMercator(), fitGeo, extent);
  }
  const path = d3.geoPath(proj);

  svg.attr('viewBox', `0 0 ${mapArea.clientWidth} ${mapArea.clientHeight}`);

  // Base layer: a neutral "land but no data" grey that shows through wherever a
  // unit polygon doesn't exist (e.g. Maine's unorganized townships).
  //
  // Every state except Maine uses the union of its own unit polygons as the
  // base — the units tile the state completely, so this is pixel-exact and can
  // never leave slivers or false land bridges the way a separately-generalized
  // state outline does. Maine's units intentionally DON'T tile the state
  // (unorganized townships stay grey), so it uses a dedicated 1:500k outline.
  let baseGeom = null;
  if (abbr === 'ME') {
    if (!state.geoCache['ME_OUTLINE']) {
      try { state.geoCache['ME_OUTLINE'] = await loadJSON('data/geo/new_england/me_outline_topo.json'); }
      catch (e) { state.geoCache['ME_OUTLINE'] = null; }
    }
    if (myToken !== state.renderToken) return; // navigation changed while fetching outline
    const ot = state.geoCache['ME_OUTLINE'];
    baseGeom = ot
      ? topojson.feature(ot, ot.objects.outline).features[0]
      : stateOutlineFeature;
  } else {
    baseGeom = topojson.merge(geoTopo, geoTopo.objects[objKey].geometries);
  }
  if (baseGeom) {
    gLayer.append('path')
      .attr('class', 'map-base-outline')
      .attr('d', path(baseGeom))
      .attr('fill', '#D8D6CC')
      .attr('stroke', '#FFFFFF')
      .attr('stroke-width', 1);
  }

  gLayer.selectAll('path.map-unit')
    .data(geo.features)
    .join('path')
    .attr('class', 'map-unit')
    .attr('id', d => 'unit-' + d.id)
    .attr('d', path)
    .attr('fill', d => {
      const unit = unitForFeature(data, d.id);
      return unit ? unitColor(unit, state.colorMode) : '#ddd';
    })
    .on('mousemove', (event, d) => showTooltipUnit(event, d, data))
    .on('mouseleave', hideTooltip)
    .on('click', (event, d) => selectUnit(unitKeyForFeature(data, d.id), data));

  // City labels — non-interactive overlay; counter-scaled on zoom so they keep
  // constant screen size (see setupZoom).
  if (!state.cityLabels) {
    try { state.cityLabels = await loadJSON('data/geo/city_labels.json'); }
    catch (e) { state.cityLabels = {}; }
  }
  if (myToken !== state.renderToken) return;
  const cities = (state.cityLabels[abbr] || []).map(c => {
    const p = proj([c.lon, c.lat]);
    return p ? { name: c.n, px: p[0], py: p[1] } : null;
  }).filter(Boolean);
  if (cities.length) {
    const layer = gLayer.append('g').attr('class', 'city-layer');
    const g = layer.selectAll('g.city')
      .data(cities)
      .join('g')
      .attr('class', 'city')
      .attr('transform', d => `translate(${d.px},${d.py})`);
    g.append('circle').attr('class', 'city-dot').attr('r', 2.8);
    g.append('text').attr('class', 'city-text').attr('x', 6).attr('y', 4.5).text(d => d.name);
  }

  updateSearchPlaceholder();
}

function showTooltipUnit(event, d, stateData) {
  const unit = unitForFeature(stateData, d.id);
  if (!unit) return;
  const candidateR = shortCandidate(stateData.candidate_R);
  const candidateD = shortCandidate(stateData.candidate_D);
  tooltip.innerHTML = `
    <div class="tt-name">${unit.name}</div>
    <div class="tt-row"><span class="tt-cand" style="color:${COLORS.red}">${candidateR}</span><span class="tt-val">${fmtNum(unit.votes_R)} · ${fmtPct(unit.pct_R)}%</span></div>
    <div class="tt-row"><span class="tt-cand" style="color:${COLORS.blue}">${candidateD}</span><span class="tt-val">${fmtNum(unit.votes_D)} · ${fmtPct(unit.pct_D)}%</span></div>
    <div class="tt-hint">Click for full modal breakdown</div>
  `;
  positionTooltip(event);
}

function selectUnit(unitId, stateData) {
  state.selectedUnitId = unitId;
  svg.selectAll('.map-unit').classed('selected', d => unitKeyForFeature(stateData, d.id) === unitId);
  // Raise the selected unit to the top of paint order — otherwise later-drawn
  // neighboring units paint over the shared edges of its highlight stroke.
  const selectedEls = svg.selectAll('.map-unit')
    .filter(d => unitKeyForFeature(stateData, d.id) === unitId);
  if (!selectedEls.empty()) selectedEls.raise();
  // Keep city labels above the raised selection.
  const cityLayer = svg.select('g.city-layer');
  if (!cityLayer.empty()) cityLayer.raise();
  const markerEl = document.getElementById('overseasMarker');
  if (markerEl) markerEl.classList.toggle('active', unitId === markerEl.dataset.unitId);
  removeCoverageStrip();
  renderUnitPanel(stateData.units[unitId], stateData);
  updateBreadcrumb();
  updateBackButton();
}

function deselectUnit() {
  // Drop back from a selected county/ward/district to the state-level profile view.
  state.selectedUnitId = null;
  svg.selectAll('.map-unit').classed('selected', false);
  document.getElementById('overseasMarker')?.classList.remove('active');
  const data = currentStateData();
  if (data) renderStatePanel(data);
  updateBreadcrumb();
  updateBackButton();
}

function setupOverseasMarker() {
  const marker = document.getElementById('overseasMarker');
  marker.addEventListener('click', () => {
    const unitId = marker.dataset.unitId;
    const data = currentStateData();
    if (!unitId || !data || !data.units[unitId]) return;
    selectUnit(unitId, data);
  });
}

// ============ BREADCRUMB / BACK NAVIGATION ============

function updateBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  if (state.view === 'national') {
    bc.innerHTML = `<span class="crumb current">United States</span>`;
    return;
  }
  const data = currentStateData();
  const unit = (data && state.selectedUnitId) ? data.units[state.selectedUnitId] : null;

  if (unit) {
    bc.innerHTML = `
      <span class="crumb" id="bcUS">United States</span>
      <span class="sep">›</span>
      <span class="crumb" id="bcState">${data.state}</span>
      <span class="sep">›</span>
      <span class="crumb current">${unit.name}</span>
    `;
    document.getElementById('bcUS').addEventListener('click', renderNationalView);
    document.getElementById('bcState').addEventListener('click', deselectUnit);
  } else if (data) {
    bc.innerHTML = `
      <span class="crumb" id="bcUS">United States</span>
      <span class="sep">›</span>
      <span class="crumb current">${data.state}</span>
    `;
    document.getElementById('bcUS').addEventListener('click', renderNationalView);
  }
}

function updateBreadcrumbForMissingState(stateName) {
  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = `
    <span class="crumb" id="bcUS">United States</span>
    <span class="sep">›</span>
    <span class="crumb current">${stateName}</span>
  `;
  document.getElementById('bcUS').addEventListener('click', renderNationalView);
}

function updateBackButton() {
  const btn = document.getElementById('backBtn');
  const label = document.getElementById('backBtnLabel');
  if (state.view === 'national') {
    btn.classList.remove('visible');
    return;
  }
  btn.classList.add('visible');
  const data = currentStateData();
  if (state.selectedUnitId && data) {
    label.textContent = `Back to ${data.state}`;
  } else {
    label.textContent = 'Back to United States';
  }
}

function handleBack() {
  if (state.view === 'state' && state.selectedUnitId) {
    deselectUnit();
  } else {
    renderNationalView();
  }
}

function setupBackButton() {
  document.getElementById('backBtn').addEventListener('click', handleBack);
}

// ============ SIDEBAR PANEL ============

function setPanelHeader(eyebrow, title, subtitle) {
  document.getElementById('panelEyebrow').textContent = eyebrow;
  document.getElementById('panelTitle').textContent = title;
  document.getElementById('panelSubtitle').textContent = subtitle || '';
}

function unitTypeLabel(type, plural) {
  const map = { county: ['county','counties'], town: ['town','towns'], district: ['district','districts'], ward: ['ward','wards'] };
  const pair = map[type] || ['unit','units'];
  return plural ? pair[1] : pair[0];
}

function titleCaseWord(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---- National-level panel ----
function renderNationalPanel() {
  const n = state.national;
  let usD = 0, usR = 0, usOther = 0, usTotal = 0;
  Object.values(n.states).forEach(s => { usD += s.votes_D; usR += s.votes_R; usOther += s.votes_other; usTotal += s.total_votes; });
  const pctD = (100 * usD / usTotal).toFixed(1), pctR = (100 * usR / usTotal).toFixed(1);
  const sample = Object.values(n.states)[0];
  const candidateR = shortCandidate(sample?.candidate_R);
  const candidateD = shortCandidate(sample?.candidate_D);
  const isPresident = state.race === 'president';
  const trackedVotes = n.total_votes || usTotal;

  setPanelHeader('National summary', 'United States', `2024 ${RACES[state.race].adjective} results`);

  document.getElementById('panelContent').innerHTML = `
    ${isPresident ? `
      <div class="data-section">
        <div class="section-label">2024 national result</div>
        <div class="candidate-row">
          <span class="cand-swatch" style="background:${COLORS.red}"></span>
          <span class="cand-name" title="${sample.candidate_R}">${candidateR}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pctR}%; background:${COLORS.red}"></div></div>
          <span class="bar-pct">${pctR}%</span>
        </div>
        <div class="candidate-row">
          <span class="cand-swatch" style="background:${COLORS.blue}"></span>
          <span class="cand-name" title="${sample.candidate_D}">${candidateD}</span>
          <div class="bar-track"><div class="bar-fill" style="width:${pctD}%; background:${COLORS.blue}"></div></div>
          <span class="bar-pct">${pctD}%</span>
        </div>
      </div>
    ` : `
      <div class="data-section">
        <div class="section-label">2024 ${raceLabel()} races</div>
        <div class="race-stat"><strong>${n.contest_count}</strong><span>contests</span></div>
        <div class="race-stat"><strong>${n.jurisdiction_count}</strong><span>states</span></div>
      </div>
    `}
    <div class="data-section">
      <div class="section-label">About this project</div>
      <div class="profile-text">
        VoteMode tracks 2024 ${RACES[state.race].adjective} results broken down by voting method at the county level—and by town, district, or ward where states report that way. Click a state with a race to begin exploring.
      </div>
    </div>
    <div class="data-section">
      <div class="section-label">Total votes tracked</div>
      <div class="profile-text" style="font-family: var(--font-mono); font-size: 16px; color: var(--ink); font-weight: 600;">
        ${fmtNum(trackedVotes)}
      </div>
    </div>
  `;
}

// ---- State-level panel (no unit selected) ----
function renderStatePanel(data) {
  setPanelHeader('State profile', data.state, `2024 ${data.race_label} · ${data.unit_count} ${unitTypeLabel(data.unit_type, true)}`);
  const grade = data.avg_completeness;
  const gradeColor = coverageColor(grade);
  const candidateR = shortCandidate(data.candidate_R);
  const candidateD = shortCandidate(data.candidate_D);

  const profile = data.state_profile || {};
  const hasNarrative = profile.voting_summary && profile.voting_summary.trim().length > 0;

  document.getElementById('panelContent').innerHTML = `
    <div class="data-section">
      <div class="section-label">Reporting quality</div>
      <div class="grade-row">
        <div class="grade-circle" style="background:${gradeColor}22; color:${gradeColor}; border: 1.5px solid ${gradeColor}66;">${grade}</div>
        <div class="grade-desc">${completenessLabel(grade)} is the most common rating across this state's ${data.unit_count} ${unitTypeLabel(data.unit_type, true)}.</div>
      </div>
    </div>
    <div class="data-section">
      <div class="section-label">How ${data.state} votes</div>
      <div class="profile-text">
        ${hasNarrative ? profile.voting_summary : `<em style="color: var(--ink-tertiary)">State voting profile not yet written; this section will describe ${data.state}'s voting methods, deadlines, and reporting timeline.</em>`}
      </div>
    </div>
    <div class="data-section">
      <div class="section-label">Statewide ${data.contest === 'special' ? 'special-election ' : ''}result</div>
      <div class="candidate-row">
        <span class="cand-swatch" style="background:${COLORS.red}"></span>
        <span class="cand-name" title="${data.candidate_R}">${candidateR}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${data.pct_R}%; background:${COLORS.red}"></div></div>
        <span class="bar-pct">${fmtPct(data.pct_R)}%</span>
      </div>
      <div class="candidate-row">
        <span class="cand-swatch" style="background:${COLORS.blue}"></span>
        <span class="cand-name" title="${data.candidate_D}">${candidateD}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${data.pct_D}%; background:${COLORS.blue}"></div></div>
        <span class="bar-pct">${fmtPct(data.pct_D)}%</span>
      </div>
    </div>
  `;

  renderCoverageStripInPanel(data);
}

// ---- Unit-level panel (county / town / district / ward selected) ----
function renderUnitPanel(unit, stateData) {
  if (!unit) return;
  setPanelHeader(`${unitTypeLabel(stateData.unit_type, false)} detail`, unit.name, `${stateData.race_label} · ${stateData.state}`);
  const candidateR = shortCandidate(stateData.candidate_R);
  const candidateD = shortCandidate(stateData.candidate_D);

  const showPct = state.numberMode === 'percent';
  const modeKeys = Object.keys(unit.modes || {});
  let modeRows = '';
  if (modeKeys.length) {
    modeRows = modeKeys.map(k => {
      const m = unit.modes[k];
      const modeTotal = (m.votes_D || 0) + (m.votes_R || 0) + (m.votes_other || 0);
      const rDisplay = showPct ? (modeTotal ? (100 * m.votes_R / modeTotal).toFixed(1) + '%' : '0.0%') : fmtNum(m.votes_R);
      const dDisplay = showPct ? (modeTotal ? (100 * m.votes_D / modeTotal).toFixed(1) + '%' : '0.0%') : fmtNum(m.votes_D);
      return `<tr>
        <td>${MODE_LABELS[k] || k}</td>
        <td class="td-r">${rDisplay}</td>
        <td class="td-d">${dDisplay}</td>
      </tr>`;
    }).join('');
  }
  const totalRDisplay = showPct ? fmtPct(unit.pct_R) + '%' : fmtNum(unit.votes_R);
  const totalDDisplay = showPct ? fmtPct(unit.pct_D) + '%' : fmtNum(unit.votes_D);

  const badgeClass = 'q-' + (unit.completeness || 'u').toLowerCase();
  const badgeLabel = completenessLabel(unit.completeness);

  document.getElementById('panelContent').innerHTML = `
    <div class="data-section">
      <div class="section-label">Overall result</div>
      <div class="candidate-row">
        <span class="cand-swatch" style="background:${COLORS.red}"></span>
        <span class="cand-name" title="${stateData.candidate_R}">${candidateR}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${unit.pct_R}%; background:${COLORS.red}"></div></div>
        <span class="bar-pct">${fmtPct(unit.pct_R)}%</span>
      </div>
      <div class="candidate-row">
        <span class="cand-swatch" style="background:${COLORS.blue}"></span>
        <span class="cand-name" title="${stateData.candidate_D}">${candidateD}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${unit.pct_D}%; background:${COLORS.blue}"></div></div>
        <span class="bar-pct">${fmtPct(unit.pct_D)}%</span>
      </div>
    </div>

    <div class="data-section">
      <div class="section-label-row">
        <div class="section-label">Modal breakdown</div>
        ${modeKeys.length ? `
        <div class="mini-toggle" id="modeNumberToggle">
          <button class="${!showPct ? 'active' : ''}" data-mode="votes">Votes</button>
          <button class="${showPct ? 'active' : ''}" data-mode="percent">Percent</button>
        </div>` : ''}
      </div>
      ${modeKeys.length ? `
      <table class="mode-table">
        <thead><tr><th>Mode</th><th>${candidateR}</th><th>${candidateD}</th></tr></thead>
        <tbody>
          ${modeRows}
          <tr class="total-row"><td>Total</td><td class="td-r">${totalRDisplay}</td><td class="td-d">${totalDDisplay}</td></tr>
        </tbody>
      </table>
      ` : `<div class="profile-text">No modal breakdown available — only a combined total has been reported for this unit.</div>`}
      <div class="quality-badge ${badgeClass}">
        <span class="q-dot"></span>${badgeLabel}
      </div>
      <div class="source-note">
        Source: ${unit.data_source || 'unknown'} ${unit.official_results ? '· Official' : '· Unofficial'}
        ${unit.notes ? '<br>' + unit.notes : ''}
      </div>
    </div>

    <div class="download-row">
      <button class="dl-btn" id="dlBtn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download ${stateData.state_abbr} data (CSV / JSON)
      </button>
    </div>
  `;

  const ab = stateData.state_abbr.toLowerCase();
  const contestSuffix = stateData.contest === 'special' ? '_special' : '';
  const fileBase = `votemode_${ab}_2024_${stateData.race}${contestSuffix}`;
  document.getElementById('dlBtn').addEventListener('click', () => {
    downloadFile(`${fileBase}.csv`, stateCSV(stateData), 'text/csv');
    // Slight stagger so the browser treats both saves as one user action.
    setTimeout(() => downloadFile(`${fileBase}.json`, JSON.stringify(stateData, null, 1), 'application/json'), 350);
  });

  setupNumberToggle();
}

function setupNumberToggle() {
  const wrap = document.getElementById('modeNumberToggle');
  if (!wrap) return;
  wrap.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.numberMode === btn.dataset.mode) return;
      state.numberMode = btn.dataset.mode;
      const stateData = currentStateData();
      if (stateData && state.selectedUnitId) {
        renderUnitPanel(stateData.units[state.selectedUnitId], stateData);
      }
    });
  });
}

function completenessLabel(code) {
  if (!code) return 'No data yet';
  if (code === 'U') return 'Totals only · no modal breakdown';
  if (code === 'F') return 'Not yet sourced';
  const n = parseInt(code.replace('C',''), 10);
  return `${n} vote method${n > 1 ? 's' : ''} reported (${code})`;
}

function renderCoverageStripInPanel(data) {
  const units = Object.values(data.units);
  const cells = units.map(u => {
    const c = u.completeness || 'UNKNOWN';
    return `<div class="cov-cell" style="background:${coverageColor(c)}" title="${u.name}: ${completenessLabel(c)}"></div>`;
  }).join('');

  let wrap = document.getElementById('coverageStripWrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'coverageStripWrap';
    wrap.className = 'coverage-strip-wrap';
    document.getElementById('panelContent').after(wrap);
  }
  wrap.innerHTML = `
    <div class="cov-label">Modal coverage · ${data.state} (${units.length} ${unitTypeLabel(data.unit_type, true)})</div>
    <div class="cov-row">${cells}</div>
    <div class="cov-legend"><span>More methods reported</span><span>Fewer / none</span></div>
  `;
}

function removeCoverageStrip() {
  const wrap = document.getElementById('coverageStripWrap');
  if (wrap) wrap.remove();
}

// ============ LEGEND ============

function renderLegend() {
  const el = document.getElementById('mapLegend');
  if (state.colorMode === 'coverage') {
    el.innerHTML = `
      <div class="legend-row"><span class="legend-swatch" style="background:${coverageColor('C5')}"></span>5+ methods reported</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${coverageColor('C3')}"></span>3 methods reported</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${coverageColor('C1')}"></span>1 method reported</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${coverageColor('U')}"></span>Totals only</div>
      ${state.view === 'national' ? `<div class="legend-row"><span class="legend-swatch" style="background:repeating-linear-gradient(45deg, ${coverageColor('C3')}, ${coverageColor('C3')} 3px, ${coverageColor('U')} 3px, ${coverageColor('U')} 6px)"></span>Mixed (two most common)</div>` : `<div class="legend-row"><span class="legend-swatch" style="background:${coverageColor('F')}"></span>Not yet sourced</div>`}
      ${state.view === 'national' && state.race !== 'president' ? `<div class="legend-row"><span class="legend-swatch" style="background:${NO_RACE_COLOR}"></span>No ${raceLabel()} race</div>` : ''}
    `;
  } else {
    const isPresident = state.race === 'president';
    el.innerHTML = `
      <div class="legend-row"><span class="legend-swatch" style="background:${COLORS.red}"></span>${isPresident ? 'Solid Trump' : 'Strong Republican lead'}</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${COLORS.redSoft}"></span>${isPresident ? 'Lean Trump' : 'Lean Republican'}</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${COLORS.blueSoft}"></span>${isPresident ? 'Lean Harris' : 'Lean Democratic / independent'}</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${COLORS.blue}"></span>${isPresident ? 'Solid Harris' : 'Strong Democratic / independent lead'}</div>
      ${state.view === 'national' && !isPresident ? `<div class="legend-row"><span class="legend-swatch" style="background:${NO_RACE_COLOR}"></span>No ${raceLabel()} race</div>` : ''}
    `;
  }
}

// ============ VIEW TOGGLE ============

function setupViewToggle() {
  document.querySelectorAll('.view-toggle button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-toggle button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.colorMode = btn.dataset.view;
      renderLegend();
      if (state.view === 'national') {
        svg.selectAll('.map-unit').attr('fill', d =>
          nationalFill(state.national.states[STATE_NAME_TO_ABBR[d.properties.name]]));
      } else {
        const data = currentStateData();
        if (data) {
          svg.selectAll('.map-unit').attr('fill', d => {
            const unit = unitForFeature(data, d.id);
            return unit ? unitColor(unit, state.colorMode) : '#ddd';
          });
        }
      }
    });
  });
}

// ============ SEARCH ============

function setupSearch() {
  const box = document.getElementById('searchBox');
  const results = document.getElementById('searchResults');

  box.addEventListener('input', () => {
    const q = box.value.trim().toLowerCase();
    if (!q) { results.classList.remove('open'); return; }

    let matches = [];
    if (state.view === 'national') {
      matches = Object.entries(state.national.states)
        .filter(([abbr, s]) => s.name.toLowerCase().includes(q))
        .map(([abbr, s]) => ({ label: s.name, meta: abbr, action: () => enterState(abbr) }));
    } else {
      const data = currentStateData();
      if (data) {
        matches = Object.entries(data.units)
          .filter(([id, u]) => u.name.toLowerCase().includes(q))
          .map(([id, u]) => ({ label: u.name, meta: data.state_abbr, action: () => { selectUnit(id, data); box.value=''; results.classList.remove('open'); } }));
      }
    }
    matches = matches.slice(0, 8);

    if (!matches.length) {
      results.innerHTML = `<div class="search-result-item" style="color:var(--ink-tertiary)">No matches</div>`;
    } else {
      results.innerHTML = matches.map((m, i) =>
        `<div class="search-result-item" data-idx="${i}"><span class="search-result-name">${m.label}</span><span class="search-result-meta">${m.meta}</span></div>`
      ).join('');
      results.querySelectorAll('.search-result-item').forEach((el, i) => {
        el.addEventListener('click', () => { matches[i].action(); results.classList.remove('open'); box.value=''; });
      });
    }
    results.classList.add('open');
  });

  document.addEventListener('click', (e) => {
    if (!box.contains(e.target) && !results.contains(e.target)) results.classList.remove('open');
  });

  box.addEventListener('focus', () => { if (box.value) results.classList.add('open'); });
}

function updateSearchPlaceholder() {
  const box = document.getElementById('searchBox');
  box.placeholder = state.view === 'national' ? `Search ${raceLabel()} states…` : `Search ${unitTypeLabel(currentStateData()?.unit_type, true)}…`;
}

// ============ UTIL ============

function fmtNum(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

// ============ DOWNLOADS ============

function csvEscape(v) {
  v = String(v ?? '');
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Long-format CSV: one 'all' row per unit plus one row per reported vote method.
function stateCSV(data) {
  const rows = [['race','contest','state','unit_id','unit','fips','mode','candidate_D','candidate_R','votes_candidate_D','votes_candidate_R','votes_other','votes_total','completeness','data_source','official_results']];
  for (const [id, u] of Object.entries(data.units)) {
    rows.push([data.race, data.contest, data.state_abbr, id, u.name, u.fips || '', 'all', data.candidate_D, data.candidate_R, u.votes_D, u.votes_R, u.votes_other, u.total_votes, u.completeness || '', u.data_source || '', u.official_results]);
    for (const [m, v] of Object.entries(u.modes || {})) {
      const t = (v.votes_D || 0) + (v.votes_R || 0) + (v.votes_other || 0);
      rows.push([data.race, data.contest, data.state_abbr, id, u.name, u.fips || '', m, data.candidate_D, data.candidate_R, v.votes_D, v.votes_R, v.votes_other, t, '', '', '']);
    }
  }
  return rows.map(r => r.map(csvEscape).join(',')).join('\n');
}

function nationalCSV() {
  const rows = [['race','contest','state','name','candidate_D','candidate_R','votes_candidate_D','votes_candidate_R','votes_other','votes_total','pct_candidate_D','pct_candidate_R','unit_count','avg_completeness']];
  for (const [ab, s] of Object.entries(state.national.states)) {
    rows.push([state.race, s.contest, ab, s.name, s.candidate_D, s.candidate_R, s.votes_D, s.votes_R, s.votes_other, s.total_votes, s.pct_D, s.pct_R, s.unit_count, s.avg_completeness]);
  }
  return rows.map(r => r.map(csvEscape).join(',')).join('\n');
}

function setupDownloads() {
  document.getElementById('downloadTopBtn').addEventListener('click', () => {
    if (state.view === 'state') {
      const d = currentStateData();
      if (d) {
        const contestSuffix = d.contest === 'special' ? '_special' : '';
        downloadFile(`votemode_${d.state_abbr.toLowerCase()}_2024_${d.race}${contestSuffix}.csv`, stateCSV(d), 'text/csv');
        return;
      }
    }
    downloadFile(`votemode_national_2024_${state.race}.csv`, nationalCSV(), 'text/csv');
  });
}

// Always display percentages with exactly one decimal place (47 -> "47.0")
function fmtPct(p) {
  const v = Number(p);
  return Number.isFinite(v) ? v.toFixed(1) : 'n/a';
}

// ============ START ============
init();
