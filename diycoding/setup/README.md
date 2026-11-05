# Setting up the r/DIYaesthetics coding site

The site is static files on GitHub Pages (this `diycoding/` folder). Logins, codes, post text, and images live in the Supabase project `xcvnadowxogedxzlrhhm`. Post text and images are never committed to this public repo.

## 1. Create the tables

In Supabase, open SQL Editor, start a new query, paste all of `schema.sql`, and click Run. It creates the tables, the security rules, and a private `post-images` storage bucket. Running it again does no harm.

## 2. Turn off public sign-up

Go to Authentication, then Sign In / Providers. Turn off "Allow new users to sign up" and leave the Email provider on. Coders can then only log in with accounts you create.

## 3. Add the coders

For each coder, go to Authentication, then Users, then Add user, then Create new user. Enter their email and a password, and tick "Auto Confirm User". Send them the password yourself.

Then add every coder, including yourself, to the coder list in SQL Editor. Use lowercase emails. `is_admin` gives access to the Admin page with progress and CSV export.

```sql
insert into public.coders (email, name, is_admin) values
  ('you@university.edu', 'Dan', true),
  ('coder2@university.edu', 'Janelle', false)
on conflict (email) do update set name = excluded.name, is_admin = excluded.is_admin;
```

A login that is not on this list sees a "Not on the coder list" message and cannot read any posts.

## 4. Load the sample

`build_sample.py` draws the sample, downloads the images, and uploads both. It has to run on your Mac because it needs to reach Reddit. Get the secret key from Project Settings, then API Keys (the `sb_secret_...` one). Keep that key off GitHub and out of the site.

```bash
cd ~/Dropbox/Research/reddit/diyaesthetics/platform
export SUPABASE_URL="https://xcvnadowxogedxzlrhhm.supabase.co"
export SUPABASE_SECRET_KEY="sb_secret_..."
python3 build_sample.py --n 200 --name reliability_1
```

The defaults are 200 posts and seed 20261105, so the same command always draws the same posts. Posts by AutoModerator and posts whose text was removed and that have no images are left out of the pool (178 of 11,444). The script writes `sample_reliability_1.csv` listing the sampled posts and how many images were saved for each. Add `--no-upload` to stop before anything goes to Supabase.

To draw a later sample (for example the main coding round), use a new `--name`, then change `sampleName` in `config.js` to match.

## 5. Edit the codes

The codes shown to coders come from `codes.json`. Edit it on GitHub (open the file, click the pencil) and the site shows the change once GitHub Pages redeploys, usually within a few minutes. Keep each `key` the same once coding starts, since the key is the CSV column name. Adding a code is safe; posts already marked complete will show it as blank in the export until a coder revisits them.

## 6. Export

Log in as an admin, open Admin, and download the wide CSV (one row per post and coder, one 0/1 column per code) or the long CSV (one row per post, coder, and code). When a coder marks a post complete, every code is saved, with untouched codes saved as 0.

## Notes

- Supabase pauses free projects after a stretch with no activity (about a week). If the site stops loading data, open the Supabase dashboard and restore the project.
- Comments can be added later as rows in `units` with `unit_type = 'comment'`; the coding tables already key on `unit_id`, so they need no change.
