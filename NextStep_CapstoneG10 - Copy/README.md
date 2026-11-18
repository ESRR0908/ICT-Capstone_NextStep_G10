# NextStep (Davao) - setup
1. `pip install -r requirements.txt`
2. Copy `backend/.env.example` to `backend/.env` and fill in your NEW NVIDIA key and an ADMIN_TOKEN.
3. Index the schools (scrapes websites, asks the AI to match degrees, geocodes pins; takes several minutes):
   `python backend/indexer.py 3`   (test with 3 schools first)  then  `python backend/indexer.py`
4. Start the app: `python backend/server.py` and open http://127.0.0.1:5000
5. Fix a missing pin / program list by hand (Facebook-only schools, failed geocoding):
   curl -X POST http://127.0.0.1:5000/api/admin/school -H "X-Admin-Token: YOUR_TOKEN" -H "Content-Type: application/json" -d '{"id":"ichef","lat":7.07,"lng":125.61,"degree_ids":["bsba"]}'
Folder layout: nextstep/{index.html,app.js,styles.css,requirements.txt} and nextstep/backend/{server.py,config.py,database.py,indexer.py,matcher.py,ai_client.py,catalog.py,.env}
Delete the old data.js (no longer used).
