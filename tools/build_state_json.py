#!/usr/bin/env python3
"""
Rebuild data/states/*.json and data/national.json from the combined 2024
dataset in Documents/2024.

Source of truth is combined/us_2024_president.csv (9,543 rows, 51
jurisdictions), which the 2026-08-05 review confirmed matches the 51 per-state
processed files exactly. That file has no votes_other column and no
completeness metadata, so both are derived here:

  votes_other   = total_votes - votes_D - votes_R
  completeness  = 'U' if the unit's only mode is Total, else C<n> where n is
                  the count of distinct normalized modes it breaks out
                  (the definition published in about.html)

Unit keys:
  - County-reporting states: 5-digit FIPS from the CSV (collision-proof).
  - Town/district/ward states (CT MA ME NH RI VT AK DC): slug of the FULL
    raw unit name — lowercased, every run of non-alphanumerics replaced by
    a single underscore. No suffix stripping, so LINCOLN and LINCOLN
    PLANTATION can never collide.

Display names, notes, pct_off_official and state_profile prose are preserved
from the existing JSONs; mode_split inside state_profile is recomputed.

Usage:  python3 build_state_json.py [--src PATH_TO_COMBINED_CSV] [--site PATH_TO_Website]
"""
import json, csv, re, os, sys, argparse
from collections import Counter, defaultdict

TOWN_LIKE = {'CT','MA','ME','NH','RI','VT','AK','DC'}
# Reporting units that should be folded into another unit (id -> id), per state.
MERGE = {'RI': {'providence_limited': 'providence'}}
# The 2024 dataset spells out direction words that the map geometry and the
# existing JSONs abbreviate, and names Alaska's overseas district differently.
# Left side is the key slug(2024 name) produces; right side is the key the
# topojson uses. Without these the units would land as brand-new unmappable
# entries and the old ones would vanish.
KEY_ALIAS = {
    'MA': {f'{long}_{rest}': f'{short}_{rest}' for short, long, rest in [
        ('e','east','bridgewater'), ('e','east','brookfield'), ('e','east','longmeadow'),
        ('n','north','adams'), ('n','north','andover'), ('n','north','attleborough'),
        ('n','north','brookfield'), ('n','north','reading'), ('s','south','hadley'),
        ('w','west','boylston'), ('w','west','bridgewater'), ('w','west','brookfield'),
        ('w','west','newbury'), ('w','west','springfield'), ('w','west','stockbridge'),
        ('w','west','tisbury')]},
    'VT': {f'{long}_{rest}': f'{short}_{rest}' for short, long, rest in [
        ('e','east','haven'), ('e','east','montpelier'), ('n','north','hero'),
        ('s','south','burlington'), ('s','south','hero'), ('w','west','fairlee'),
        ('w','west','haven'), ('w','west','rutland'), ('w','west','windsor')]},
    'AK': {'district_99_federal_overseas': 'hd99_fed_overseas_absentee'},
}
# Units the 2024 dataset does not carry that must survive from the existing
# JSON. Maine's export omits the UOCAVA ballots entirely — its own validator
# records the statewide shortfall rather than closing it — and the site renders
# that unit as a floating map pill (FLOATING_UNITS in app.js).
CARRY_FORWARD = {'ME': ['state_uocava']}
# Non-geographic units (shown as the floating map pill, never mapped)
NE_GEO = {'CT':'new_england/ct_towns_topo.json','ME':'new_england/me_towns_topo.json',
          'MA':'new_england/ma_towns_topo.json','NH':'new_england/nh_towns_topo.json',
          'RI':'new_england/ri_towns_topo.json','VT':'new_england/vt_towns_topo.json'}

def _num(v, fallback):
    try: return float(v)
    except (TypeError, ValueError): return fallback

def slug(s):
    return re.sub(r'[^a-z0-9]+', '_', s.strip().lower()).strip('_')

def geofile(site, ab):
    if ab == 'AK': return os.path.join(site, 'data/geo/alaska/ak_districts_topo.json')
    if ab == 'DC': return os.path.join(site, 'data/geo/dc/dc_wards_topo.json')
    if ab in NE_GEO: return os.path.join(site, 'data/geo', NE_GEO[ab])
    return os.path.join(site, f'data/geo/{ab.lower()}_counties.json')

def topo_ids(site, ab):
    p = geofile(site, ab)
    if not os.path.exists(p): return None
    t = json.load(open(p))
    key = list(t['objects'].keys())[0]
    return {str(g.get('id')) for g in t['objects'][key]['geometries']}

def read_source(path, name2ab):
    """combined CSV -> {abbr: [(key, row-group), ...]} preserving file order."""
    states = defaultdict(lambda: {'order': [], 'units': {}})
    with open(path, encoding='utf-8-sig', newline='') as fh:
        for r in csv.DictReader(fh):
            ab = name2ab.get(r['state'].strip())
            if ab is None:
                sys.exit(f'unknown state in source CSV: {r["state"]!r}')
            name = r['county'].strip()
            fips = (r.get('fips') or '').strip()
            county_keyed = ab not in TOWN_LIKE
            if county_keyed:
                if not re.fullmatch(r'\d{5}', fips):
                    print(f'  {ab}: WARNING bad fips {fips!r} for {name}, using slug key')
                    key = slug(name)
                else:
                    key = fips
            else:
                key = slug(name)
            key = KEY_ALIAS.get(ab, {}).get(key, key)
            key = MERGE.get(ab, {}).get(key, key)
            st = states[ab]
            if key not in st['units']:
                st['order'].append(key)
                st['units'][key] = {
                    'name': name, 'fips': fips if county_keyed else None,
                    'modes': defaultdict(lambda: {'votes_D':0,'votes_R':0,'votes_other':0}),
                    'data_source': (r.get('data_source') or '').strip() or 'unknown',
                    'official_results': (r.get('official_results') or 'true').strip().lower() != 'false',
                }
            u = st['units'][key]
            D, R = int(r['votes_D']), int(r['votes_R'])
            T = int(r['total_votes'])
            m = u['modes'][slug(r['vote_type_normalized'])]
            m['votes_D'] += D; m['votes_R'] += R; m['votes_other'] += T - D - R
    return states

def build_state(src, site, ab):
    oldpath = os.path.join(site, 'data/states', ab.lower() + '.json')
    old = json.load(open(oldpath))
    if ab not in src:
        print(f'  {ab}: absent from source CSV — left untouched'); return None
    tids = topo_ids(site, ab)
    out_units = {}
    for key in src[ab]['order']:
        u = src[ab]['units'][key]
        modes = dict(u['modes'])
        D = sum(m['votes_D'] for m in modes.values())
        R = sum(m['votes_R'] for m in modes.values())
        O = sum(m['votes_other'] for m in modes.values())
        T = D + R + O
        broken_out = [k for k in modes if k != 'total']
        oldu = old['units'].get(key, {})
        out_units[key] = {
            'name': oldu.get('name', u['name']),
            'raw_name': u['name'],
            'fips': u['fips'],
            'is_mappable': (key in tids) if tids is not None else oldu.get('is_mappable', True),
            'votes_D': D, 'votes_R': R, 'votes_other': O, 'total_votes': T,
            'pct_D': round(100*D/T, 1) if T else 0.0,
            'pct_R': round(100*R/T, 1) if T else 0.0,
            'modes': modes,
            'data_source': u['data_source'],
            'official_results': u['official_results'],
            'pct_off_official': _num(oldu.get('pct_off_official'), 0.0),
            'completeness': f'C{len(broken_out)}' if broken_out else 'U',
            'notes': oldu.get('notes', ''),
        }
    for key in CARRY_FORWARD.get(ab, []):
        if key in out_units: continue
        oldu = old['units'].get(key)
        if oldu is None:
            print(f'  {ab}: WARNING carry-forward unit {key} not in existing JSON'); continue
        out_units[key] = oldu
        print(f'  {ab}: carried {key} forward ({oldu["total_votes"]:,} votes, not in source)')

    D = sum(u['votes_D'] for u in out_units.values())
    R = sum(u['votes_R'] for u in out_units.values())
    O = sum(u['votes_other'] for u in out_units.values())
    T = D + R + O
    cb = Counter(u['completeness'] for u in out_units.values())

    # mode_split: statewide share of the vote by method, one decimal.
    ms = Counter()
    for u in out_units.values():
        for k, m in u['modes'].items():
            ms[k] += m['votes_D'] + m['votes_R'] + m['votes_other']
    profile = dict(old.get('state_profile', {}))
    if T:
        profile['mode_split'] = {k: round(100*v/T, 1)
                                 for k, v in sorted(ms.items(), key=lambda kv: -kv[1])}

    new = {
        'state': old['state'], 'state_abbr': ab, 'unit_type': old['unit_type'],
        'avg_completeness': cb.most_common(1)[0][0],
        'completeness_breakdown': dict(cb),
        'votes_D': D, 'votes_R': R, 'votes_other': O, 'total_votes': T,
        'pct_D': round(100*D/T, 1), 'pct_R': round(100*R/T, 1),
        'unit_count': len(out_units),
        'state_profile': profile,
        'units': out_units,
    }
    json.dump(new, open(oldpath, 'w'), indent=1)
    unmapped = [k for k, u in out_units.items() if not u['is_mappable']]
    delta = T - old['total_votes']
    print(f'  {ab}: {len(out_units)} units, {T:,} votes ({delta:+,})'
          + (f' | unmapped: {unmapped}' if unmapped else ''))
    return new

def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--src', default=os.path.join(here, '..', '..', '2024',
                                                  'combined', 'us_2024_president.csv'))
    ap.add_argument('--site', default=os.path.join(here, '..'))
    args = ap.parse_args()
    src_path, site = os.path.abspath(args.src), os.path.abspath(args.site)
    print(f'src:  {src_path}\nsite: {site}')

    natp = os.path.join(site, 'data/national.json')
    nat = json.load(open(natp))
    name2ab = {v['name']: k for k, v in nat['states'].items()}
    src = read_source(src_path, name2ab)
    cov_notes = []

    for f in sorted(os.listdir(os.path.join(site, 'data/states'))):
        ab = f.split('.')[0].upper()
        new = build_state(src, site, ab)
        if new and ab in nat['states']:
            nat['states'][ab].update(
                votes_D=new['votes_D'], votes_R=new['votes_R'], votes_other=new['votes_other'],
                total_votes=new['total_votes'], pct_D=new['pct_D'], pct_R=new['pct_R'],
                avg_completeness=new['avg_completeness'], unit_count=new['unit_count'],
                completeness_breakdown=new['completeness_breakdown'])
            for msg in check_cov(ab, nat['states'][ab]):
                cov_notes.append(msg)
    json.dump(nat, open(natp, 'w'), indent=1)
    print('national.json updated')
    if cov_notes:
        print('\ncoverage-fill (`cov`) needs a human decision:')
        for m in cov_notes: print('  ' + m)

def check_cov(ab, s):
    """The national map's solid/striped fill is hand-tuned (see the CT/NM
    solid-color rule), so it is never regenerated here. Report only the states
    where the stored value no longer describes the data."""
    cov, cb = s.get('cov'), s['completeness_breakdown']
    if not cov: return []
    used = [cov['g']] if cov['mode'] == 'solid' else list(cov['g'])
    gone = [g for g in used if g not in cb]
    if gone:
        return [f'{ab}: cov references {gone} which no longer exist — '
                f'breakdown is now {cb}']
    top = Counter(cb).most_common(1)[0][0]
    if used[0] != top:
        return [f'{ab}: cov leads with {used[0]} but {top} is now the most '
                f'common grade — breakdown is {cb}']
    return []

if __name__ == '__main__':
    main()
