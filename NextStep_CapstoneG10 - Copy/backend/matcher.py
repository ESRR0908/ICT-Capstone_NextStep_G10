# matcher.py : subject classification and grade-to-degree matching
import re  # word-start matching for keywords
import ai_client  # AI fallback for unknown subjects
import config  # weights and penalty
from catalog import DEGREES, SUBJECT_CATALOG  # reference data

EXACT = {n.lower(): t for n, t in SUBJECT_CATALOG}  # lowercase subject name -> type
HINTS = [  # keyword rules used when the exact name is not in the catalog (checked in order)
    (("applied economics", "research", "empowerment", "entrepreneur", "academic and professional", "piling larang", "immersion"), "Applied"),
    (("oral communication", "reading and writing", "literature", "media and information", "general mathematics",
      "statistics and probability", "earth and life", "physical science", "philosophy", "culture, society",
      "personal development", "physical education", "komunikasyon", "pagbasa"), "Core"),
    (("calculus", "biology", "physics", "chemistry", "accountancy", "programming", "marketing", "management",
      "economics", "creative", "social sciences", "world religions"), "Specialized"),
]


def classify_subject(name):  # returns {"type": ..., "source": ...}
    clean = " ".join(name.lower().split())  # normalise spaces and case
    if clean in EXACT:  # exact catalog match
        return {"type": EXACT[clean], "source": "catalog"}  # done
    for words, kind in HINTS:  # try keyword rules
        if any(w in clean for w in words):  # a keyword appears
            return {"type": kind, "source": "rules"}  # done
    try:  # last resort: ask the AI
        kind = ai_client.classify_subject_ai(name)  # may return None
        if kind:  # valid answer
            return {"type": kind, "source": "ai"}  # done
    except Exception:  # AI down, timeout, bad reply: any failure must not break the app
        pass  # fall through to the default
    return {"type": "Specialized", "source": "default"}  # safe default, student can change it


def related(subject_name, keywords):  # True if a degree keyword starts a word in the subject name
    text = subject_name.lower()  # compare in lowercase
    return any(re.search(r"\b" + re.escape(k.strip().lower()), text) for k in keywords if k.strip())  # "art" no longer matches inside "Participation"


def avg(nums):  # average that returns 0 for an empty list
    return sum(nums) / len(nums) if nums else 0  # arithmetic mean


def analyze(subjects, encae, school_map):  # returns top 5 degrees; school_map = degree id -> school ids
    w = config.WEIGHTS  # scoring weights
    core_avg = avg([s["grade"] for s in subjects if s["type"] != "Specialized"])  # Core + Applied average
    spec_avg = avg([s["grade"] for s in subjects if s["type"] == "Specialized"])  # Specialized average
    base = core_avg or avg([s["grade"] for s in subjects])  # fallback if no core subjects
    out = []  # all scored degrees
    for d in DEGREES:  # score every degree
        rel = [s for s in subjects if related(s["name"], d["keywords"])]  # subjects relevant to this degree
        spec_score = avg([s["grade"] for s in rel]) if rel else (spec_avg or base) * 0.85  # relevant grades or a penalty
        score = w["core"] * base + w["spec"] * spec_score + w["encae"] * encae  # weighted total (0-100)
        meets_avg, meets_encae = base >= d["min_avg"], encae >= d["min_encae"]  # requirement checks
        if not (meets_avg and meets_encae):  # any requirement missed?
            score -= config.PENALTY  # apply penalty
        breakdown = [{"name": s["name"], "grade": s["grade"], "meets": s["grade"] >= d["min_avg"]} for s in rel]  # per-subject check (same rule as meetsAvg)
        out.append({"id": d["id"], "name": d["name"], "career": d["career"], "minAvg": d["min_avg"],
                    "minEncae": d["min_encae"], "meetsAvg": meets_avg, "meetsEncae": meets_encae,
                    "pct": max(0, min(100, round(score))), "breakdown": breakdown,
                    "schools": school_map.get(d["id"], [])})  # one scored degree
    out.sort(key=lambda r: (r["pct"], r["meetsAvg"] and r["meetsEncae"], len(r["breakdown"])), reverse=True)  # best first; ties go to degrees whose requirements are met, then to more related subjects
    return out[:5]  # top five
