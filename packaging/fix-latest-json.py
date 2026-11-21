"""Point a release's latest.json at the normal download links.

tauri-action writes GitHub API asset links while the release is a draft. Those need special headers and count
against the API's rate limit for anonymous users, so installed copies could fail to update. Usage:
    python fix-latest-json.py <repo> <tag>   (needs the gh CLI, signed in)
"""
import json, subprocess, sys, tempfile, os

repo, tag = sys.argv[1], sys.argv[2]
rel = json.loads(subprocess.check_output(["gh", "release", "view", tag, "-R", repo, "--json", "assets"], text=True, encoding="utf-8"))
by_id = {}
for a in rel["assets"]:
    by_id[a["apiUrl"].rsplit("/", 1)[-1]] = f"https://github.com/{repo}/releases/download/{tag}/{a['name']}"
d = json.loads(subprocess.check_output(["gh", "release", "download", tag, "-R", repo, "-p", "latest.json", "-O", "-"]))
changed = 0
for p in d["platforms"].values():
    if "/releases/assets/" in p["url"]:
        p["url"] = by_id[p["url"].rsplit("/", 1)[-1]]
        changed += 1
out = os.path.join(tempfile.mkdtemp(), "latest.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(d, f, indent=2)
if changed:
    subprocess.check_call(["gh", "release", "upload", tag, out, "-R", repo, "--clobber"])
print(f"{changed} links rewritten")
for k, v in d["platforms"].items():
    print(k, v["url"])
