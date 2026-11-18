# database.py : SQLite storage for schools, indexed programs and assessment history
import json  # convert Python lists/dicts to text and back
import sqlite3  # built-in database engine
from contextlib import contextmanager  # lets us use "with" for connections

import config  # our settings
from catalog import SCHOOL_SEEDS, DEGREES  # seed data


@contextmanager  # turns the function below into a "with" helper
def conn():  # open a connection, commit on success, always close
    c = sqlite3.connect(config.DB_PATH)  # open (or create) the database file
    c.row_factory = sqlite3.Row  # rows behave like dictionaries
    try:  # run the caller's code
        yield c  # hand the connection to the caller
        c.commit()  # save changes if no error happened
    finally:  # always run this part
        c.close()  # release the file


def init_db():  # create tables and insert seed schools
    with conn() as c:  # open a connection
        c.executescript("""
            CREATE TABLE IF NOT EXISTS schools (
                id TEXT PRIMARY KEY, name TEXT, url TEXT, kind TEXT, scrape INTEGER,
                address TEXT, lat REAL, lng REAL, last_indexed TEXT);
            CREATE TABLE IF NOT EXISTS school_programs (
                school_id TEXT, degree_id TEXT, source TEXT, PRIMARY KEY (school_id, degree_id));
            CREATE TABLE IF NOT EXISTS assessments (
                id TEXT PRIMARY KEY, created_at TEXT, date_label TEXT, encae INTEGER,
                g11 TEXT, g12 TEXT, results TEXT, owner TEXT);
        """)  # three tables: schools, which degrees each school offers, saved assessments (with an owner id)
        cols = [r["name"] for r in c.execute("PRAGMA table_info(assessments)").fetchall()]  # existing column names
        if "owner" not in cols:  # database was created by the older version
            c.execute("ALTER TABLE assessments ADD COLUMN owner TEXT")  # add the missing column
        for sid, name, url, kind, scrape in SCHOOL_SEEDS:  # loop over seed schools
            c.execute("INSERT OR IGNORE INTO schools (id,name,url,kind,scrape) VALUES (?,?,?,?,?)",
                      (sid, name, url, kind, int(scrape)))  # add only if the school is not there yet


def update_school(sid, name=None, address=None, lat=None, lng=None, indexed_at=None):  # save scraped details
    with conn() as c:  # open a connection
        c.execute("""UPDATE schools SET name=COALESCE(?,name), address=COALESCE(?,address),
                     lat=COALESCE(?,lat), lng=COALESCE(?,lng), last_indexed=COALESCE(?,last_indexed)
                     WHERE id=?""", (name, address, lat, lng, indexed_at, sid))  # keep old value when new is None


def school_exists(sid):  # True when a school with this id is in the table (used by the admin endpoint)
    with conn() as c:  # open a connection
        return c.execute("SELECT 1 FROM schools WHERE id=?", (sid,)).fetchone() is not None  # one row found?


def set_programs(sid, degree_ids, source):  # replace the degrees a school offers
    with conn() as c:  # open a connection
        c.execute("DELETE FROM school_programs WHERE school_id=?", (sid,))  # remove old rows
        c.executemany("INSERT OR IGNORE INTO school_programs VALUES (?,?,?)",
                      [(sid, d, source) for d in degree_ids])  # insert new rows


def list_schools(only_mapped=True):  # schools with coordinates and their program names
    names = {d["id"]: d["name"] for d in DEGREES}  # degree id -> degree name
    with conn() as c:  # open a connection
        rows = c.execute("SELECT * FROM schools").fetchall()  # every school
        progs = c.execute("SELECT school_id, degree_id FROM school_programs").fetchall()  # every school/degree pair
    by_school = {}  # school id -> list of degree names
    for p in progs:  # loop over pairs
        by_school.setdefault(p["school_id"], []).append(names.get(p["degree_id"], p["degree_id"]))  # collect names
    out = []  # result list
    for r in rows:  # loop over schools
        if only_mapped and (r["lat"] is None or r["lng"] is None):  # skip schools with no pin yet
            continue  # go to next school
        out.append({"id": r["id"], "name": r["name"], "url": r["url"], "kind": r["kind"],
                    "address": r["address"] or "Davao City", "lat": r["lat"], "lng": r["lng"],
                    "programs": by_school.get(r["id"], [])})  # one school dictionary
    return out  # return list


def degree_schools():  # degree id -> list of school ids that offer it (only mapped schools)
    with conn() as c:  # open a connection
        rows = c.execute("""SELECT p.degree_id, p.school_id FROM school_programs p
                            JOIN schools s ON s.id=p.school_id WHERE s.lat IS NOT NULL""").fetchall()  # join pairs with mapped schools
    out = {}  # result dictionary
    for r in rows:  # loop over pairs
        out.setdefault(r["degree_id"], []).append(r["school_id"])  # group by degree
    return out  # return mapping


def save_assessment(rec, owner):  # insert one assessment record for one browser
    with conn() as c:  # open a connection
        c.execute("""INSERT INTO assessments (id,created_at,date_label,encae,g11,g12,results,owner)
                     VALUES (?,?,?,?,?,?,?,?)""",
                  (rec["id"], rec["iso"], rec["dateLabel"], rec["encae"],
                   json.dumps(rec["g11"]), json.dumps(rec["g12"]), json.dumps(rec["results"]), owner))  # lists stored as JSON text


def _to_dict(r):  # convert one database row into the dictionary the frontend expects
    return {"id": r["id"], "iso": r["created_at"], "dateLabel": r["date_label"], "encae": r["encae"],
            "g11": json.loads(r["g11"]), "g12": json.loads(r["g12"]), "results": json.loads(r["results"])}  # JSON text back to lists


def list_assessments(owner):  # this owner's records, newest first
    with conn() as c:  # open a connection
        rows = c.execute("SELECT * FROM assessments WHERE owner=? ORDER BY created_at DESC", (owner,)).fetchall()  # only their rows
    return [_to_dict(r) for r in rows]  # convert every row


def get_assessment(aid, owner):  # one record, only if it belongs to this owner
    with conn() as c:  # open a connection
        r = c.execute("SELECT * FROM assessments WHERE id=? AND owner=?", (aid, owner)).fetchone()  # look it up
    return _to_dict(r) if r else None  # dictionary or None


def delete_assessment(aid, owner):  # remove a record by id (only the owner's)
    with conn() as c:  # open a connection
        return c.execute("DELETE FROM assessments WHERE id=? AND owner=?", (aid, owner)).rowcount  # rows deleted
