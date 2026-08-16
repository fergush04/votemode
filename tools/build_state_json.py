#!/usr/bin/env python3
"""Build race-scoped website JSON from the combined 2024 CSV files.

Outputs live under data/races/<race>/ so the map can switch among President,
Senate, and Governor without duplicating shared geometry. Regular state files
use ``<abbr>.json``; California and Nebraska Senate special elections use
``<abbr>_special.json``.

The combined CSVs have no votes_other or completeness fields, so this builder
derives them:

  votes_other   = total_votes - votes_D - votes_R
  completeness  = U when the unit only reports Total, otherwise C<n>, where n
                  is the number of distinct normalized voting modes

Display names, notes, unit types, and state voting-profile prose are preserved
from the existing presidential JSON files.

Usage: python build_state_json.py [--race all|president|senate|governor]
                                  [--source-dir PATH] [--site PATH]
"""

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict


RACES = {
    "president": {
        "label": "President",
        "source": "us_2024_president.csv",
        "contest_count": 51,
        "jurisdiction_count": 51,
    },
    "senate": {
        "label": "Senate",
        "source": "us_2024_senate.csv",
        "contest_count": 35,
        "jurisdiction_count": 33,
    },
    "governor": {
        "label": "Governor",
        "source": "us_2024_governor.csv",
        "contest_count": 11,
        "jurisdiction_count": 11,
    },
}

TOWN_LIKE = {"CT", "MA", "ME", "NH", "RI", "VT", "AK", "DC"}
MERGE = {"RI": {"providence_limited": "providence"}}
KEY_ALIAS = {
    "MA": {f"{long}_{rest}": f"{short}_{rest}" for short, long, rest in [
        ("e", "east", "bridgewater"), ("e", "east", "brookfield"),
        ("e", "east", "longmeadow"), ("n", "north", "adams"),
        ("n", "north", "andover"), ("n", "north", "attleborough"),
        ("n", "north", "brookfield"), ("n", "north", "reading"),
        ("s", "south", "hadley"), ("w", "west", "boylston"),
        ("w", "west", "bridgewater"), ("w", "west", "brookfield"),
        ("w", "west", "newbury"), ("w", "west", "springfield"),
        ("w", "west", "stockbridge"), ("w", "west", "tisbury"),
    ]},
    "VT": {f"{long}_{rest}": f"{short}_{rest}" for short, long, rest in [
        ("e", "east", "haven"), ("e", "east", "montpelier"),
        ("n", "north", "hero"), ("s", "south", "burlington"),
        ("s", "south", "hero"), ("w", "west", "fairlee"),
        ("w", "west", "haven"), ("w", "west", "rutland"),
        ("w", "west", "windsor"),
    ]},
    "AK": {"district_99_federal_overseas": "hd99_fed_overseas_absentee"},
}

# The presidential Maine source omits a separately reported statewide UOCAVA
# unit that the original site data includes. It is safe to preserve only for
# President; carrying presidential votes into another race would be incorrect.
CARRY_FORWARD_PRESIDENT = {"ME": ["state_uocava"]}

NE_GEO = {
    "CT": "new_england/ct_towns_topo.json",
    "ME": "new_england/me_towns_topo.json",
    "MA": "new_england/ma_towns_topo.json",
    "NH": "new_england/nh_towns_topo.json",
    "RI": "new_england/ri_towns_topo.json",
    "VT": "new_england/vt_towns_topo.json",
}

# A few source rows combine adjacent reporting units that remain separate in
# the map geometry. Both polygons point to the one source unit without
# duplicating its votes in statewide totals.
GEOMETRY_ALIASES = {
    ("senate", "ME", "regular"): {
        "wesley": "wesley_day_block_twp",
        "day_block_twp": "wesley_day_block_twp",
    },
}


def _num(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def slug(value):
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def contest_key(race_type):
    return "special" if race_type == "senate_special" else "regular"


def contest_label(key):
    return "Special" if key == "special" else "Regular"


def geofile(site, abbr):
    if abbr == "AK":
        return os.path.join(site, "data/geo/alaska/ak_districts_topo.json")
    if abbr == "DC":
        return os.path.join(site, "data/geo/dc/dc_wards_topo.json")
    if abbr in NE_GEO:
        return os.path.join(site, "data/geo", NE_GEO[abbr])
    return os.path.join(site, f"data/geo/{abbr.lower()}_counties.json")


def topo_ids(site, abbr):
    path = geofile(site, abbr)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as fh:
        topo = json.load(fh)
    key = next(iter(topo["objects"]))
    return {str(geometry.get("id"))
            for geometry in topo["objects"][key]["geometries"]}


def new_contest():
    return {
        "order": [],
        "units": {},
        "candidate_D": None,
        "candidate_R": None,
        "race_type": None,
    }


def read_source(path, name_to_abbr):
    """Return source data grouped by abbreviation and contest."""
    states = defaultdict(lambda: defaultdict(new_contest))
    with open(path, encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            abbr = name_to_abbr.get(row["state"].strip())
            if abbr is None:
                sys.exit(f"unknown state in source CSV: {row['state']!r}")

            race_type = row["race_type"].strip()
            key = contest_key(race_type)
            contest = states[abbr][key]
            pair = (row["candidate_D"].strip(), row["candidate_R"].strip())
            if contest["candidate_D"] is None:
                contest["candidate_D"], contest["candidate_R"] = pair
                contest["race_type"] = race_type
            elif pair != (contest["candidate_D"], contest["candidate_R"]):
                sys.exit(f"several candidate pairs in {abbr} {key}: {pair!r}")
            if contest["race_type"] != race_type:
                sys.exit(f"several race types in {abbr} {key}")

            name = row["county"].strip()
            fips = (row.get("fips") or "").strip()
            county_keyed = abbr not in TOWN_LIKE
            if county_keyed:
                if not re.fullmatch(r"\d{5}", fips):
                    print(f"  {abbr}: WARNING bad fips {fips!r} for {name}; using slug")
                    unit_key = slug(name)
                else:
                    unit_key = fips
            else:
                unit_key = slug(name)
            unit_key = KEY_ALIAS.get(abbr, {}).get(unit_key, unit_key)
            unit_key = MERGE.get(abbr, {}).get(unit_key, unit_key)

            if unit_key not in contest["units"]:
                contest["order"].append(unit_key)
                contest["units"][unit_key] = {
                    "name": name,
                    "fips": fips if county_keyed else None,
                    "modes": defaultdict(
                        lambda: {"votes_D": 0, "votes_R": 0, "votes_other": 0}),
                    "data_source": (row.get("data_source") or "").strip() or "unknown",
                    "official_results": (
                        (row.get("official_results") or "true").strip().lower()
                        != "false"
                    ),
                }

            unit = contest["units"][unit_key]
            votes_d = int(row["votes_D"])
            votes_r = int(row["votes_R"])
            total = int(row["total_votes"])
            normalized = (row.get("vote_type_normalized") or "").strip()
            mode_key = slug(normalized) or slug(row.get("vote_type") or "") or "unallocated"
            mode = unit["modes"][mode_key]
            mode["votes_D"] += votes_d
            mode["votes_R"] += votes_r
            mode["votes_other"] += total - votes_d - votes_r
    return states


def build_state(contest, site, abbr, race, key):
    """Convert one state contest to the website state JSON shape."""
    old_path = os.path.join(site, "data/states", abbr.lower() + ".json")
    with open(old_path, encoding="utf-8") as fh:
        old = json.load(fh)
    tids = topo_ids(site, abbr)
    geometry_aliases = GEOMETRY_ALIASES.get((race, abbr, key), {})
    aliased_units = set(geometry_aliases.values())
    out_units = {}

    for unit_key in contest["order"]:
        source_unit = contest["units"][unit_key]
        modes = dict(source_unit["modes"])
        votes_d = sum(mode["votes_D"] for mode in modes.values())
        votes_r = sum(mode["votes_R"] for mode in modes.values())
        votes_other = sum(mode["votes_other"] for mode in modes.values())
        total = votes_d + votes_r + votes_other
        broken_out = [mode for mode in modes if mode != "total"]
        old_unit = old["units"].get(unit_key, {})
        out_units[unit_key] = {
            "name": old_unit.get("name", source_unit["name"]),
            "raw_name": source_unit["name"],
            "fips": source_unit["fips"],
            "is_mappable": ((unit_key in tids or unit_key in aliased_units)
                            if tids is not None
                            else old_unit.get("is_mappable", True)),
            "votes_D": votes_d,
            "votes_R": votes_r,
            "votes_other": votes_other,
            "total_votes": total,
            "pct_D": round(100 * votes_d / total, 1) if total else 0.0,
            "pct_R": round(100 * votes_r / total, 1) if total else 0.0,
            "modes": modes,
            "data_source": source_unit["data_source"],
            "official_results": source_unit["official_results"],
            "pct_off_official": _num(old_unit.get("pct_off_official"), 0.0),
            "completeness": f"C{len(broken_out)}" if broken_out else "U",
            "notes": old_unit.get("notes", ""),
        }

    if race == "president":
        for unit_key in CARRY_FORWARD_PRESIDENT.get(abbr, []):
            if unit_key in out_units:
                continue
            old_unit = old["units"].get(unit_key)
            if old_unit is not None:
                out_units[unit_key] = old_unit
                print(f"  {abbr}: carried forward {unit_key}")

    votes_d = sum(unit["votes_D"] for unit in out_units.values())
    votes_r = sum(unit["votes_R"] for unit in out_units.values())
    votes_other = sum(unit["votes_other"] for unit in out_units.values())
    total = votes_d + votes_r + votes_other
    breakdown = Counter(unit["completeness"] for unit in out_units.values())

    mode_split = Counter()
    for unit in out_units.values():
        for mode_key, mode in unit["modes"].items():
            mode_split[mode_key] += (
                mode["votes_D"] + mode["votes_R"] + mode["votes_other"])
    profile = dict(old.get("state_profile", {}))
    if total:
        profile["mode_split"] = {
            mode_key: round(100 * value / total, 1)
            for mode_key, value in sorted(
                mode_split.items(), key=lambda item: -item[1])
        }

    result = {
        "race": race,
        "race_label": RACES[race]["label"],
        "race_type": contest["race_type"],
        "contest": key,
        "contest_label": contest_label(key),
        "candidate_D": contest["candidate_D"],
        "candidate_R": contest["candidate_R"],
        "state": old["state"],
        "state_abbr": abbr,
        "unit_type": old["unit_type"],
        "avg_completeness": breakdown.most_common(1)[0][0],
        "completeness_breakdown": dict(breakdown),
        "votes_D": votes_d,
        "votes_R": votes_r,
        "votes_other": votes_other,
        "total_votes": total,
        "pct_D": round(100 * votes_d / total, 1) if total else 0.0,
        "pct_R": round(100 * votes_r / total, 1) if total else 0.0,
        "unit_count": len(out_units),
        "state_profile": profile,
        "geometry_aliases": geometry_aliases,
        "units": out_units,
    }
    unmapped = [unit_key for unit_key, unit in out_units.items()
                if not unit["is_mappable"]]
    print(f"  {abbr} {key}: {len(out_units)} units, {total:,} votes"
          + (f" | unmapped: {unmapped}" if unmapped else ""))
    return result


def coverage_fill(state_data, old_national_state, race):
    """Return the national coverage-map fill descriptor."""
    if race == "president" and old_national_state.get("cov"):
        return old_national_state["cov"]
    ranking = Counter(state_data["completeness_breakdown"]).most_common()
    if len(ranking) == 1:
        return {"mode": "solid", "g": ranking[0][0]}
    return {"mode": "stripe", "g": [ranking[0][0], ranking[1][0]]}


def state_summary(data, old_national_state, race, options):
    keys = [
        "votes_D", "votes_R", "votes_other", "total_votes", "pct_D", "pct_R",
        "avg_completeness", "unit_count", "completeness_breakdown",
        "candidate_D", "candidate_R", "contest", "contest_label", "race_type",
    ]
    summary = {"name": data["state"], "unit_type": data["unit_type"]}
    summary.update({key: data[key] for key in keys})
    summary["contests"] = options
    summary["cov"] = coverage_fill(data, old_national_state, race)
    return summary


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(value, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


def build_race(race, source_dir, site, name_to_abbr, old_national):
    config = RACES[race]
    source_path = os.path.join(source_dir, config["source"])
    source = read_source(source_path, name_to_abbr)
    found_contests = sum(len(contests) for contests in source.values())
    if found_contests != config["contest_count"]:
        raise ValueError(f"{race}: found {found_contests} contests, expected "
                         f"{config['contest_count']}")
    if len(source) != config["jurisdiction_count"]:
        raise ValueError(f"{race}: found {len(source)} jurisdictions, expected "
                         f"{config['jurisdiction_count']}")

    output_root = os.path.join(site, "data", "races", race)
    national = {
        "race": race,
        "race_label": config["label"],
        "year": 2024,
        "contest_count": found_contests,
        "jurisdiction_count": len(source),
        "total_votes": 0,
        "states": {},
    }

    print(f"{config['label']}: {source_path}")
    for abbr in sorted(source):
        contests = source[abbr]
        ordered_keys = sorted(contests, key=lambda value: value == "special")
        options = [{"key": key, "label": contest_label(key)}
                   for key in ordered_keys]
        built = {}
        for key in ordered_keys:
            data = build_state(contests[key], site, abbr, race, key)
            built[key] = data
            national["total_votes"] += data["total_votes"]
            suffix = "_special" if key == "special" else ""
            output_path = os.path.join(
                output_root, "states", abbr.lower() + suffix + ".json")
            write_json(output_path, data)
        default_key = "regular" if "regular" in built else ordered_keys[0]
        national["states"][abbr] = state_summary(
            built[default_key], old_national["states"][abbr], race, options)

    write_json(os.path.join(output_root, "national.json"), national)
    print(f"  wrote {output_root}\n")


def main():
    parser = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    parser.add_argument(
        "--race", choices=["all", *RACES], default="all",
        help="race dataset to build (default: all)",
    )
    parser.add_argument(
        "--source-dir",
        default=os.path.join(here, "..", "..", "2024", "combined"),
    )
    parser.add_argument("--site", default=os.path.join(here, ".."))
    args = parser.parse_args()

    source_dir = os.path.abspath(args.source_dir)
    site = os.path.abspath(args.site)
    with open(os.path.join(site, "data", "national.json"), encoding="utf-8") as fh:
        old_national = json.load(fh)
    name_to_abbr = {
        value["name"]: key for key, value in old_national["states"].items()
    }

    selected = RACES if args.race == "all" else [args.race]
    for race in selected:
        build_race(race, source_dir, site, name_to_abbr, old_national)


if __name__ == "__main__":
    main()
