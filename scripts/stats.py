"""Quick console summary of matrix.json (distribution, review queue, top keywords)."""
import collections
import json
from pathlib import Path

m = json.loads((Path(__file__).resolve().parents[1] / "matrix.json").read_text(encoding="utf-8"))
it = m["items"]
print(f"total={len(it)} classified={m['counts']['classified']} needs_review={m['counts']['needs_review']}")
print("\nDOMAINS")
for k, v in collections.Counter(i["domain"] for i in it).most_common():
    print(f"  {k:28} {v}")
print("\nFORMS")
for k, v in collections.Counter(i["form"] for i in it).most_common():
    print(f"  {k:28} {v}")
print("\nMATURITY", dict(collections.Counter(i["maturity"] for i in it)))
print("\nNEEDS REVIEW")
for i in it:
    if i["needs_review"]:
        print(f"  {str(i['upstream']):45} dom={i['domain']:24} conf={i['confidence']} proposed={i.get('proposed_domain')}")
print("\nTOP KEYWORDS", [(k, len(v)) for k, v in list(m["keywords"].items())[:30]])
