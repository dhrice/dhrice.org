#!/usr/bin/env python3
"""
Draw a coding sample of r/DIYaesthetics posts, download their images, and upload
both to Supabase for the coding site.

Run on your own computer (it needs internet access to Reddit and Supabase):

    export SUPABASE_URL="https://xcvnadowxogedxzlrhhm.supabase.co"
    export SUPABASE_SECRET_KEY="sb_secret_..."      # Supabase > Project Settings > API Keys
    python3 build_sample.py --posts ../data/r_DIYaesthetics_posts.jsonl --n 200 --name reliability_1

What it does, in order:
  1. Reads the posts JSONL and drops posts with nothing to code (removed/deleted text and no media,
     AutoModerator posts).
  2. Draws a simple random sample of --n posts with a fixed --seed, so the same command always
     gives the same sample. Writes sample_<name>.csv next to this script.
  3. Downloads each sampled post's images into images/<post id>/, shrunk to at most --max-px
     pixels on the long side (needs Pillow; without it the originals are kept).
  4. Uploads the images to the private 'post-images' bucket, then the posts to the 'units' table
     and the sample order to the 'samples' table.

It can be re-run safely: downloaded images are reused and database rows are overwritten.
Use --no-upload to stop after step 3 and look at things first.
Use --add-to-existing to keep an existing sample's posts and only add new ones (for a bigger sample later).
"""
import argparse, csv, html, json, mimetypes, os, random, sys, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    Image = None

UA = "diyaesthetics-coding-study/1.0 (academic research; image archiving for content analysis)"
BUCKET = "post-images"
HERE = Path(__file__).resolve().parent


# ---------- reading posts ----------

def unesc(s):
    return html.unescape(s) if isinstance(s, str) else s


def media_for(p):
    """Return (media_kind, [ {src, kind} ]) for a Reddit post object."""
    items = []
    kind = "none"
    mm = p.get("media_metadata") or {}

    def from_meta(meta):
        if not meta or meta.get("status") != "valid":
            return None
        s = meta.get("s") or {}
        src = s.get("u") or s.get("gif")
        if not src and s.get("mp4"):
            return None
        return unesc(src) if src else None

    if p.get("is_gallery"):
        kind = "gallery"
        order = [it.get("media_id") for it in (p.get("gallery_data") or {}).get("items", [])] or list(mm.keys())
        for mid in order:
            src = from_meta(mm.get(mid))
            if src:
                items.append({"src": src, "kind": "image"})
    elif p.get("is_video"):
        kind = "video"
        imgs = (p.get("preview") or {}).get("images") or []
        if imgs and imgs[0].get("source", {}).get("url"):
            items.append({"src": unesc(imgs[0]["source"]["url"]), "kind": "video_still"})
    else:
        url = p.get("url") or ""
        if p.get("domain") == "i.redd.it" or url.lower().split("?")[0].endswith((".jpg", ".jpeg", ".png", ".gif", ".webp")):
            kind = "image"
            items.append({"src": url, "kind": "image"})
        elif not p.get("is_self"):
            kind = "link"
            imgs = (p.get("preview") or {}).get("images") or []
            if imgs and imgs[0].get("source", {}).get("url"):
                items.append({"src": unesc(imgs[0]["source"]["url"]), "kind": "link_preview"})
        # images pasted inside a text post
        for mid, meta in mm.items():
            src = from_meta(meta)
            if src:
                items.append({"src": src, "kind": "image"})
                if kind == "none":
                    kind = "image"
    return kind, items


def to_unit(p):
    kind, items = media_for(p)
    body = unesc(p.get("selftext") or "")
    return {
        "id": p.get("name") or "t3_" + p["id"],
        "unit_type": "post",
        "post_id": p.get("name") or "t3_" + p["id"],
        "parent_id": None,
        "subreddit": p.get("subreddit"),
        "author": p.get("author"),
        "created_utc": int(p.get("created_utc") or 0),
        "title": unesc(p.get("title") or ""),
        "body": body,
        "permalink": "https://www.reddit.com" + (p.get("permalink") or ""),
        "url": p.get("url"),
        "domain": p.get("domain"),
        "flair": unesc(p.get("link_flair_text")),
        "score": p.get("score"),
        "num_comments": p.get("num_comments"),
        "media_kind": kind,
        "media": items,
        "removed": body.strip() in ("[removed]", "[deleted]") or bool(p.get("removed_by_category")),
    }


def eligible(u):
    if (u["author"] or "").lower() == "automoderator":
        return False
    if u["body"].strip() in ("[removed]", "[deleted]") and not u["media"]:
        return False
    return True


# ---------- images ----------

def download(src, dest_base):
    """Download src to dest_base.<ext>, shrink, and return the local path (or None)."""
    existing = list(dest_base.parent.glob(dest_base.name + ".*"))
    if existing:
        return existing[0]
    req = urllib.request.Request(src, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = r.read()
            ctype = r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        print(f"    image unavailable ({e.code}): {src}")
        return None
    except Exception as e:
        print(f"    image failed ({e}): {src}")
        return None
    if "image" not in ctype:
        print(f"    not an image ({ctype}): {src}")
        return None
    dest_base.parent.mkdir(parents=True, exist_ok=True)
    raw = dest_base.with_suffix(".orig")
    raw.write_bytes(data)
    out = dest_base.with_suffix(".jpg")
    if Image is not None:
        try:
            with Image.open(raw) as im:
                im.seek(0)
                im = im.convert("RGB")
                im.thumbnail((ARGS.max_px, ARGS.max_px))
                im.save(out, "JPEG", quality=82, optimize=True)
            raw.unlink()
            return out
        except Exception as e:
            print(f"    could not resize ({e}), keeping original")
    ext = mimetypes.guess_extension(ctype.split(";")[0]) or ".img"
    final = dest_base.with_suffix(ext)
    raw.rename(final)
    return final


# ---------- Supabase ----------

def sb(method, path, body=None, headers=None, raw=None):
    url = os.environ["SUPABASE_URL"].rstrip("/") + path
    key = os.environ["SUPABASE_SECRET_KEY"]
    h = {"apikey": key, "Authorization": "Bearer " + key}
    h.update(headers or {})
    data = raw
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            txt = r.read().decode() or "null"
            return json.loads(txt) if txt.strip().startswith(("[", "{")) else txt
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")
        raise SystemExit(f"Supabase error {e.code} on {method} {path}: {msg}")


def upload_image(local, remote):
    ctype = mimetypes.guess_type(str(local))[0] or "application/octet-stream"
    sb("POST", f"/storage/v1/object/{BUCKET}/{urllib.parse.quote(remote)}",
       headers={"Content-Type": ctype, "x-upsert": "true", "cache-control": "31536000"},
       raw=local.read_bytes())


def upsert(table, rows, conflict):
    for i in range(0, len(rows), 200):
        sb("POST", f"/rest/v1/{table}?on_conflict={conflict}", body=rows[i:i + 200],
           headers={"Prefer": "resolution=merge-duplicates,return=minimal"})


# ---------- main ----------

def main():
    posts_path = Path(ARGS.posts)
    units = []
    with posts_path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                units.append(to_unit(json.loads(line)))
    pool = [u for u in units if eligible(u)]
    print(f"{len(units)} posts read, {len(pool)} eligible for sampling")

    pool.sort(key=lambda u: u["id"])  # stable order so the seed always gives the same sample
    rng = random.Random(ARGS.seed)
    sample = rng.sample(pool, min(ARGS.n, len(pool)))
    sample.sort(key=lambda u: rng.random())  # random presentation order, same for every coder
    print(f"sampled {len(sample)} posts (seed {ARGS.seed})")

    img_root = HERE / "images"
    for i, u in enumerate(sample, 1):
        short = u["id"].replace("t3_", "")
        for j, m in enumerate(u["media"]):
            local = download(m["src"], img_root / short / f"{j:02d}")
            if local:
                m["path"] = f"{short}/{local.name}"
                m["_local"] = str(local)
            time.sleep(ARGS.delay)
        if i % 20 == 0:
            print(f"  images: {i}/{len(sample)} posts done")

    csv_path = HERE / f"sample_{ARGS.name}.csv"
    with csv_path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["position", "unit_id", "permalink", "title", "media_kind", "n_media", "n_media_saved"])
        for pos, u in enumerate(sample, 1):
            w.writerow([pos, u["id"], u["permalink"], u["title"], u["media_kind"], len(u["media"]),
                        sum(1 for m in u["media"] if m.get("path"))])
    n_missing = sum(1 for u in sample for m in u["media"] if not m.get("path"))
    size_mb = sum(os.path.getsize(m["_local"]) for u in sample for m in u["media"] if m.get("_local")) / 1e6
    print(f"wrote {csv_path.name}; images saved: {size_mb:.0f} MB; images unavailable: {n_missing}")

    if ARGS.no_upload:
        print("--no-upload given, stopping before Supabase.")
        return
    for var in ("SUPABASE_URL", "SUPABASE_SECRET_KEY"):
        if not os.environ.get(var):
            raise SystemExit(f"Set {var} first (see the top of this file).")

    start = 0
    if ARGS.add_to_existing:
        existing = sb("GET", f"/rest/v1/samples?select=unit_id,position&sample_name=eq.{urllib.parse.quote(ARGS.name)}")
        have = {r["unit_id"] for r in existing}
        start = max([r["position"] for r in existing] or [0])
        sample = [u for u in sample if u["id"] not in have]
        print(f"{len(have)} posts already in sample '{ARGS.name}', adding {len(sample)}")

    print("uploading images...")
    for i, u in enumerate(sample, 1):
        for m in u["media"]:
            if m.get("_local"):
                upload_image(Path(m["_local"]), m["path"])
        if i % 20 == 0:
            print(f"  {i}/{len(sample)} posts")
    rows = []
    for u in sample:
        r = dict(u)
        r["media"] = [{k: v for k, v in m.items() if not k.startswith("_")} for m in u["media"]]
        rows.append(r)
    print("uploading posts...")
    upsert("units", rows, "id")
    upsert("samples", [{"sample_name": ARGS.name, "unit_id": u["id"], "position": start + k}
                       for k, u in enumerate(sample, 1)], "sample_name,unit_id")
    print(f"done: sample '{ARGS.name}' has {start + len(sample)} posts in Supabase.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--posts", default=str(HERE.parent / "data" / "r_DIYaesthetics_posts.jsonl"))
    ap.add_argument("--n", type=int, default=200, help="number of posts to sample (default 200)")
    ap.add_argument("--seed", type=int, default=20261105, help="random seed (default 20261105)")
    ap.add_argument("--name", default="reliability_1", help="sample name; must match sampleName in config.js")
    ap.add_argument("--max-px", type=int, default=1600, help="longest image side after shrinking")
    ap.add_argument("--delay", type=float, default=0.5, help="seconds to wait between image downloads")
    ap.add_argument("--no-upload", action="store_true")
    ap.add_argument("--add-to-existing", action="store_true")
    ARGS = ap.parse_args()
    main()
