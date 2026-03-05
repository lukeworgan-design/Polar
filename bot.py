def save_exercise_new_api(ex: dict, exercise_id: str) -> int:
    """Save exercise from new GET /v3/exercises API format — including splits."""
    try:
        sport   = ex.get("sport", "")
        hr      = ex.get("heart_rate", {}) or {}
        cadence = ex.get("cadence", {}) or {}
        power   = ex.get("power", {}) or {}
        load    = ex.get("training_load_pro", {}) or {}
        zones   = ex.get("heart_rate_zones", []) or []
        start   = ex.get("start_time", "")
        dur_s   = parse_pt_seconds(ex.get("duration", ""))
        dist_m  = sf(ex.get("distance"))

        hr_zones_parsed = [{
            "zone":    z.get("index"),
            "lower":   z.get("lower-limit"),
            "upper":   z.get("upper-limit"),
            "seconds": parse_pt_seconds(z.get("in-zone", "PT0S")),
        } for z in zones]

        supabase.table("polar_exercises").upsert({
            "polar_exercise_id": exercise_id,
            "date":              start,
            "sport":             sport,
            "duration_seconds":  si(dur_s),
            "distance_meters":   dist_m,
            "calories":          si(ex.get("calories")),
            "avg_heart_rate":    si(hr.get("average")),
            "max_heart_rate":    si(hr.get("maximum")),
            "avg_cadence":       si(cadence.get("avg")),
            "max_cadence":       si(cadence.get("max")),
            "avg_power":         si(power.get("avg")),
            "max_power":         si(power.get("max")),
            "training_load":     sf(ex.get("training_load") or load.get("cardio-load")),
            "muscle_load":       sf(load.get("muscle-load")),
            "ascent":            sf(ex.get("ascent")),
            "descent":           sf(ex.get("descent")),
            "hr_zones":          json.dumps(hr_zones_parsed),
            "raw_json":          json.dumps(ex),
            "source":            "polar",
        }, on_conflict="polar_exercise_id").execute()

        # Save km splits from autoLaps — was completely missing before
        auto_laps  = ex.get("autoLaps") or ex.get("auto_laps") or []
        split_rows = []
        for lap in auto_laps:
            lap_dur = parse_pt_seconds(lap.get("duration", ""))
            lhr     = lap.get("heartRate", {}) or {}
            lspd    = lap.get("speed", {}) or {}
            lcad    = lap.get("cadence", {}) or {}
            lpwr    = lap.get("power", {}) or {}
            lap_num = lap.get("lapNumber", 0)
            split_rows.append({
                "exercise_id":        exercise_id,
                "session_date":       start[:10],
                "lap_number":         lap_num,
                "km_number":          lap_num + 1,
                "duration_seconds":   sf(lap_dur),
                "split_time_seconds": sf(parse_pt_seconds(lap.get("splitTime", ""))),
                "distance_m":         sf(lap.get("distance", 1000.0)),
                "pace_min_per_km":    sf(lap_dur / 60) if lap_dur else None,
                "pace_display":       seconds_to_pace(lap_dur),
                "hr_min":             si(lhr.get("min")),
                "hr_avg":             si(lhr.get("avg")),
                "hr_max":             si(lhr.get("max")),
                "speed_avg_ms":       sf(lspd.get("avg")),
                "speed_max_ms":       sf(lspd.get("max")),
                "cadence_avg":        si(lcad.get("avg")),
                "cadence_max":        si(lcad.get("max")),
                "ascent_m":           sf(lap.get("ascent", 0.0)),
                "descent_m":          sf(lap.get("descent", 0.0)),
                "power_avg":          si(lpwr.get("avg")),
                "power_max":          si(lpwr.get("max")),
            })

        if split_rows:
            supabase.table("polar_km_splits").upsert(
                split_rows, on_conflict="exercise_id,lap_number"
            ).execute()

        log.info(f"Saved exercise {exercise_id}: {sport} {(dist_m or 0)/1000:.1f}km, {len(split_rows)} splits")
        return len(split_rows)

    except Exception as e:
        log.error(f"Save exercise error {exercise_id}: {e}")
        return 0
