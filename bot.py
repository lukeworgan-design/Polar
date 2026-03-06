def sync_cardio_load() -> int:
    """
    Pulls cardio/muscle load from polar_exercises.raw_json
    (Polar v3 API embeds load in exercise detail, not a standalone endpoint)
    """
    try:
        from_date = (datetime.now(timezone.utc) - timedelta(days=28)).strftime("%Y-%m-%d")
        runs = supabase.table("polar_exercises")\
            .select("polar_exercise_id,date,raw_json")\
            .gte("date", from_date)\
            .not_.is_("raw_json", "null")\
            .order("date", desc=True)\
            .execute()
        
        count = 0
        for run in (runs.data or []):
            raw = run.get("raw_json")
            if not raw:
                continue
            if isinstance(raw, str):
                try:
                    raw = json.loads(raw)
                except:
                    continue
            
            load_info = raw.get("loadInformation") or {}
            cardio    = sf(load_info.get("cardioLoad"))
            muscle    = sf(load_info.get("muscleLoad"))
            status    = load_info.get("cardioLoadInterpretation")
            
            if not cardio:
                continue
            
            date_str = (run.get("date") or "")[:10]
            if not date_str:
                continue
            
            supabase.table("polar_cardio_load").upsert({
                "date":               date_str,
                "cardio_load":        cardio,
                "cardio_load_status": status,
                "muscle_load":        muscle,
                "raw_json":           json.dumps(load_info),
            }, on_conflict="date").execute()
            
            # Also keep training_load column in sync
            supabase.table("polar_exercises")\
                .update({"training_load": cardio})\
                .eq("polar_exercise_id", run["polar_exercise_id"])\
                .execute()
            
            count += 1
        
        log.info(f"Cardio load sync: {count} days from exercise raw_json")
        return count
    except Exception as e:
        log.error(f"Cardio load sync error: {e}")
        return 0
