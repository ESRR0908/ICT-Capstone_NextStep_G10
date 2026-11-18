# server.py : Flask web server. Serves the frontend and the JSON API.
# Run from the nextstep folder:  python backend/server.py   then open http://127.0.0.1:5000
import hmac  # constant-time comparison for the admin token
import re  # validate the browser id
import threading  # run the slow re-index in the background
import time  # timestamps for the classify rate limit
import uuid  # unique ids for assessment records
from datetime import datetime, timedelta, timezone  # timestamps

from flask import Flask, abort, jsonify, request, send_from_directory  # web framework pieces

import ai_client  # AI helpers
import config  # settings
import database  # storage
import indexer  # scraper + AI school indexer
import matcher  # scoring engine
from catalog import SUBJECT_CATALOG  # known subjects

app = Flask(__name__, static_folder=None)  # we serve files ourselves (whitelist only)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024  # reject request bodies bigger than 64 KB
app.config["SEND_FILE_MAX_AGE_DEFAULT"] = 0  # no caching while developing

PH_TZ = timezone(timedelta(hours=8))  # Philippine Standard Time (UTC+8, no daylight saving)
TYPES = ("Core", "Applied", "Specialized")  # allowed subject classifications
STATIC_FILES = {"index.html", "app.js", "styles.css"}  # the ONLY files the browser may download
CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,64}$")  # shape of the anonymous browser id
_reindex = {"running": False}  # flag so two re-index jobs never overlap
_classify_cache = {}  # lowercase subject name -> result, so the AI is asked once per name
_classify_hits = {}  # caller address -> recent request times (simple rate limit)
CLASSIFY_LIMIT, CLASSIFY_WINDOW = 30, 60  # at most 30 classify calls per caller per 60 seconds

database.init_db()  # create tables and seed schools when the server starts


def json_body():  # the JSON body as a dict, or {} when it is missing, invalid or not an object
    data = request.get_json(silent=True)  # parse without raising
    return data if isinstance(data, dict) else {}  # a list or string body would crash .get(), so reject it here


def client_id():  # read the anonymous browser id that keeps each student's history separate
    cid = request.headers.get("X-Client-Id", "")  # header sent by app.js
    if not CLIENT_ID_RE.match(cid):  # missing or malformed
        abort(400)  # bad request
    return cid  # valid id


def need_admin():  # stop the request unless the admin token is correct
    token = request.headers.get("X-Admin-Token", "")  # token sent by the caller
    if not config.ADMIN_TOKEN or not hmac.compare_digest(token.encode(), config.ADMIN_TOKEN.encode()):  # unset or wrong
        abort(403)  # forbidden


def clean_subjects(raw):  # validate a list of subjects from the browser
    if not isinstance(raw, list) or not raw or len(raw) > 30:  # must be 1-30 items
        raise ValueError("Add at least 1 subject for each grade level (max 30).")  # message for the user
    out = []  # cleaned list
    for s in raw:  # check each subject
        if not isinstance(s, dict):  # wrong shape
            raise ValueError("Invalid subject data.")  # message
        name = " ".join(str(s.get("name", "")).split())[:80]  # tidy spaces, cap length
        try:  # grade must be a number
            grade = float(s.get("grade"))  # convert
        except (TypeError, ValueError):  # not a number
            raise ValueError("Every grade must be a number.")  # message
        if not name or s.get("type") not in TYPES or not (60 <= grade <= 100):  # name, type, range checks (NaN fails too)
            raise ValueError("Each subject needs a name, a classification and a grade from 60 to 100.")  # message
        out.append({"name": name, "type": s["type"], "grade": grade})  # keep clean copy
    return out  # validated list


# ---------- frontend files ----------
@app.get("/")  # home page
def home():  # send index.html
    return send_from_directory(config.FRONTEND_DIR, "index.html")  # file from the nextstep folder


@app.get("/<path:name>")  # any other file request
def static_file(name):  # send only whitelisted files so backend/.env and the database stay private
    if name not in STATIC_FILES:  # not allowed
        abort(404)  # pretend it does not exist
    return send_from_directory(config.FRONTEND_DIR, name)  # send the file


# ---------- public API ----------
@app.get("/api/subjects")  # known subjects for the suggestion list
def api_subjects():  # return the catalog
    return jsonify(subjects=[{"name": n, "type": t} for n, t in SUBJECT_CATALOG])  # list of name/type pairs


@app.post("/api/classify")  # classify a subject the student typed
def api_classify():  # catalog -> keyword rules -> AI -> default
    name = " ".join(str(json_body().get("name", "")).split())[:80]  # clean name
    if not name:  # empty
        return jsonify(error="Subject name is required."), 400  # bad request
    key = name.lower()  # cache key
    if key in _classify_cache:  # asked before
        return jsonify(_classify_cache[key])  # free answer, no AI call
    now, who = time.time(), request.remote_addr or "?"  # rate limit bookkeeping
    hits = [t for t in _classify_hits.get(who, []) if now - t < CLASSIFY_WINDOW]  # keep only recent calls
    if len(hits) >= CLASSIFY_LIMIT:  # too many
        return jsonify(error="Too many requests. Please wait a moment."), 429  # protect the AI quota
    _classify_hits[who] = hits + [now]  # record this call
    result = matcher.classify_subject(name)  # catalog -> keyword rules -> AI -> default
    if result["source"] != "default" and len(_classify_cache) < 500:  # do not cache "unknown" (the AI may have been down)
        _classify_cache[key] = result  # remember it
    return jsonify(result)  # {"type": ..., "source": ...}


@app.get("/api/schools")  # Davao schools that already have a map pin
def api_schools():  # return them
    return jsonify(schools=database.list_schools(only_mapped=True))  # list of school dictionaries


@app.post("/api/analyze")  # score the student's grades and save the assessment
def api_analyze():  # main endpoint
    owner = client_id()  # whose history this belongs to
    body = json_body()  # JSON body (always a dict)
    try:  # validate the subject lists
        g11, g12 = clean_subjects(body.get("g11")), clean_subjects(body.get("g12"))  # both grade levels
    except ValueError as e:  # known validation problem
        return jsonify(error=str(e)), 400  # friendly message
    try:  # validate the ENCAE percentile
        encae = float(body.get("encae"))  # convert to a number
    except (TypeError, ValueError):  # missing or not a number
        encae = float("nan")  # force the range check below to fail
    if not (1 <= encae <= 100):  # range check (NaN fails too)
        return jsonify(error="ENCAE must be a number from 1 to 100."), 400  # friendly message
    results = matcher.analyze(g11 + g12, encae, database.degree_schools())  # top 5 degrees with school ids
    now = datetime.now(PH_TZ)  # current Philippine time
    rec = {"id": uuid.uuid4().hex[:12], "iso": now.isoformat(), "dateLabel": now.strftime("%m/%d/%Y"),
           "encae": encae, "g11": g11, "g12": g12, "results": results}  # record to store
    database.save_assessment(rec, owner)  # persist it
    return jsonify(rec)  # send it back to the browser


@app.post("/api/explain")  # AI "why this match" sentences (separate call so results show instantly)
def api_explain():  # slow, so the frontend calls it after showing the results
    owner = client_id()  # whose record
    rec = database.get_assessment(str(json_body().get("id", "")), owner)  # load the record
    if not rec:  # not found / not theirs
        return jsonify(error="Record not found."), 404  # not found
    if not config.USE_AI_EXPLANATIONS:  # feature switched off
        return jsonify(why={})  # nothing to add
    try:  # ask the model
        why = ai_client.explain_matches(rec["results"], rec["g11"] + rec["g12"], rec["encae"])  # id -> sentence
    except (ai_client.AIUnavailable, ValueError):  # AI down or bad reply
        why = {}  # silently skip
    return jsonify(why=why)  # sentences by degree id


@app.get("/api/assessments")  # this browser's history
def api_assessments():  # newest first
    return jsonify(assessments=database.list_assessments(client_id()))  # list of records


@app.delete("/api/assessments/<aid>")  # delete one record
def api_delete(aid):  # only the owner can delete
    return jsonify(deleted=database.delete_assessment(aid, client_id()))  # number of rows removed


# ---------- admin API (needs X-Admin-Token header) ----------
@app.post("/api/admin/reindex")  # start scraping + AI matching in the background
def api_reindex():  # takes several minutes
    need_admin()  # check password
    if _reindex["running"]:  # already busy
        return jsonify(status="already running"), 409  # conflict
    _reindex["running"] = True  # mark busy

    def job():  # background work
        try:  # run the indexer
            indexer.index_all()  # scrape every school
        finally:  # always clear the flag
            _reindex["running"] = False  # allow another run later
    threading.Thread(target=job, daemon=True).start()  # start in the background
    return jsonify(status="started"), 202  # accepted


@app.post("/api/admin/school")  # fix a pin or program list by hand (useful for Facebook-only schools)
def api_admin_school():  # body: {"id","lat","lng","address"?,"degree_ids"?}
    need_admin()  # check password
    b = json_body()  # JSON body (always a dict)
    s, w, n, e = config.DAVAO_BOUNDS  # Davao limits
    try:  # validate coordinates
        lat, lng = float(b["lat"]), float(b["lng"])  # numbers
    except (KeyError, TypeError, ValueError):  # missing or bad
        return jsonify(error="lat and lng are required numbers."), 400  # bad request
    if not (s <= lat <= n and w <= lng <= e):  # outside Davao
        return jsonify(error="Coordinates are outside Davao."), 400  # bad request
    sid = str(b.get("id", ""))  # which school
    if not database.school_exists(sid):  # typo protection: do not create orphan rows
        return jsonify(error="Unknown school id."), 404  # not found
    database.update_school(sid, address=b.get("address"), lat=lat, lng=lng)  # save the pin
    if isinstance(b.get("degree_ids"), list):  # programs supplied
        database.set_programs(sid, [d for d in b["degree_ids"] if d in ai_client.DEGREE_IDS], "manual")  # valid ids only
    return jsonify(status="saved")  # done


if __name__ == "__main__":  # when run as a script
    app.run(host="127.0.0.1", port=5000, debug=True, use_reloader=False)  # no auto-restart, so saving a file cannot kill a running re-index
