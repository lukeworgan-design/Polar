# Dashboard background photo

To set a background photo for the family TV dashboard, add an image here named:

    assets/dashboard-bg.jpg      (or .jpeg, .png, .webp)

Rose serves it at `/dashboard-bg` and shows it (dimmed) behind the dashboard
cards automatically — no third-party image host or `DASHBOARD_BG_URL` needed.

Tips:
- Landscape orientation, ideally 1920×1080 or larger.
- Calmer / darker photos read best behind the text; it sits under a dark overlay.
- To turn the photo off on a specific TV, add `&photo=off` to that TV's URL.

Prefer an external URL instead? Set the `DASHBOARD_BG_URL` environment variable
to any public image link and it takes precedence over this file.
