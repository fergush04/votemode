#!/usr/bin/env python3
"""
Rebuild data/states/*.json and data/national.json from the processed CSVs
in the 2024President folder.

Unit keys:
  - County-reporting states: 5-digit FIPS from the CSV (collision-proof).
  - Town/district/ward states (CT MA ME NH RI VT AK DC): slug of the FULL
    raw unit name — lowercased, every run of non-alphanumerics replaced by
    a single underscore. No suffix stripping, so LINCOLN and LINCOLN
    PLANTATION can never collide.

Display names and state_profile blocks are preserved from the existing
JSONs where the unit already exists; brand-new units default to the raw
CSV name.

Usage:  python3 build_state_json.py [--raw PATH_TO_2024President] [--site PATH_TO_Website]
"""
import json, csv, re, os, sys, argparse
from collections import Counter, defaultdict

TOWN_LIKE = {'CT','MA','ME','NH','RI','VT','AK','DC'}
# Reporting units that should be folded into another unit (id -> id), per state.
MERGE = {'RI': {'providence_limited': 'providence'}}
# Old/renamed FIPS codes -> current codes used by the map geometry.
# 46113 Shannon County was renamed Oglala Lakota County (46102) in 2015.
FIPS_ALIAS = {'SD': {'46113': '46102'}}
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

def pick(raw, ab, kind):
    st = ab.lower()
    town = os.path.join(raw, ab, 'processed', 'town', f'{st}_2024_{kind}.csv' if kind=='president' else f'{st}_town_{kind}.csv')
    county = os.path.join(raw, ab, 'processed', f'{st}_2024_{kind}.csv' if kind=='president' else f'{st}_county_{kind}.csv')
    if os.path.exists(town): return town
    if os.path.exists(county): return county
    return None

def build_state(raw, site, ab):
    oldpath = os.path.join(site, 'data/states', ab.lower() + '.json')
    old = json.load(open(oldpath))
    csvp = pick(raw, ab, 'president')
    if not csvp:
        print(f'  {ab}: no processed president CSV — left untouched'); return None
    metap = pick(raw, ab, 'metadata')
    meta = {}
    if metap:
        for r in csv.DictReader(open(metap)):
            meta[r['county']] = r

    county_keyed = ab not in TOWN_LIKE
    units, order = {}, []
    for r in csv.DictReader(open(csvp)):
        name = r['county'].strip()
        fips = (r.get('fips') or '').strip()
        if county_keyed:
            if not re.fullmatch(r'\d{5}', fips):
                print(f'  {ab}: WARNING bad fips {fips!r} for {name}, using slug key')
                key = slug(name)
            else:
                key = fips
        else:
            key = slug(name)
        key = FIPS_ALIAS.get(ab, {}).get(key, key)
        key = MERGE.get(ab, {}).get(key, key)
        if key not in units:
            order.append(key)
            units[key] = {'name': name, 'raw_name': name, 'fips': fips if county_keyed else None,
                          'modes': defaultdict(lambda: {'votes_D':0,'votes_R':0,'votes_other':0}),
                          'meta_name': name}
        m = units[key]['modes'][slug(r['vote_type_normalized'])]
        m['votes_D'] += int(r['votes_D']); m['votes_R'] += int(r['votes_R']); m['votes_other'] += int(r['votes_other'])

    tids = topo_ids(site, ab)
    out_units = {}
    for key in order:
        u = units[key]
        modes = dict(u['modes'])
        D = sum(m['votes_D'] for m in modes.values())
        R = sum(m['votes_R'] for m in modes.values())
        O = sum(m['votes_other'] for m in modes.values())
        T = D + R + O
        md = meta.get(u['meta_name'], {})
        oldu = old['units'].get(key, {})
        out_units[key] = {
            'name': oldu.get('name', u['name']),
            'raw_name': u['raw_name'],
            'fips': u['fips'],
            'is_mappable': (key in tids) if tids is not None else oldu.get('is_mappable', True),
            'votes_D': D, 'votes_R': R, 'votes_other': O, 'total_votes': T,
            'pct_D': round(100*D/T, 1) if T else 0.0,
            'pct_R': round(100*R/T, 1) if T else 0.0,
            'modes': modes,
            'data_source': md.get('data_source', oldu.get('data_source', 'unknown')),
            'official_results': (md.get('official_results','TRUE').upper()=='TRUE') if md else oldu.get('official_results', True),
            'pct_off_official': _num(md.get('pct_off_official'), oldu.get('pct_off_official', 0)),
            'completeness': md.get('completeness', oldu.get('completeness', 'U')),
            'notes': oldu.get('notes', ''),
        }
    D = sum(u['votes_D'] for u in out_units.values())
    R = sum(u['votes_R'] for u in out_units.values())
    O = sum(u['votes_other'] for u in out_units.values())
    T = D + R + O
    cb = Counter(u['completeness'] for u in out_units.values())
    new = {
        'state': old['state'], 'state_abbr': ab, 'unit_type': old['unit_type'],
        'avg_completeness': cb.most_common(1)[0][0],
        'completeness_breakdown': dict(cb),
        'votes_D': D, 'votes_R': R, 'votes_other': O, 'total_votes': T,
        'pct_D': round(100*D/T, 1), 'pct_R': round(100*R/T, 1),
        'unit_count': len(out_units),
        'state_profile': old.get('state_profile', {}),
        'units': out_units,
    }
    json.dump(new, open(oldpath, 'w'), indent=1)
    unmapped = [k for k,u in out_units.items() if not u['is_mappable']]
    print(f'  {ab}: {len(out_units)} units, {T:,} votes' + (f' | unmapped: {unmapped}' if unmapped else ''))
    return new

def main():
    ap = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    ap.add_argument('--raw', default=os.path.join(here, '..', '..', 'Elections', '2024President'))
    ap.add_argument('--site', default=os.path.join(here, '..'))
    args = ap.parse_args()
    raw, site = os.path.abspath(args.raw), os.path.abspath(args.site)
    print(f'raw: {raw}\nsite: {site}')

    natp = os.path.join(site, 'data/national.json')
    nat = json.load(open(natp))
    for f in sorted(os.listdir(os.path.join(site, 'data/states'))):
        ab = f.split('.')[0].upper()
        new = build_state(raw, site, ab)
        if new and ab in nat['states']:
            nat['states'][ab].update(
                votes_D=new['votes_D'], votes_R=new['votes_R'], votes_other=new['votes_other'],
                total_votes=new['total_votes'], pct_D=new['pct_D'], pct_R=new['pct_R'],
                avg_completeness=new['avg_completeness'], unit_count=new['unit_count'],
                completeness_breakdown=new['completeness_breakdown'])
    json.dump(nat, open(natp, 'w'), indent=1)
    print('national.json updated')

if __name__ == '__main__':
    main()
