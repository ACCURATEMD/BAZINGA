# BAZINGA

Recruiter job board: clients, their open positions, candidates, dispatch
sheets and the closed-jobs log. `server.js` (Express + Socket.IO) serves
`public/index.html` and keeps every open browser in sync.

## Data: Firebase (Firestore)

Data is stored in Firestore in the **bazingaopens** project (override with
`FIRESTORE_PROJECT`):

| Collection / doc | Contents |
| --- | --- |
| `bazingaClients/{clientId}` | One client, its `jobs` array, and its list `order` |
| `bazingaState/closedJobs` | `{ items: [...] }`, the closed-jobs log |
| `bazingaState/settings` | `{ bgRequirementOptions: [...] }` |
| `bazingaRecommended/{jobId}` | **Written by the lobby app**: applicants matched to that job |

Every client and job has a permanent `id`. The lobby app uses the job `id` to
attach Recommended candidates, so ids are never changed by edits.

`changes.json` and `closed_jobs.json` are still written next to `server.js` as a
local backup. The first time this version starts against an empty Firestore, it
copies them into Firestore.

### Running it

- **On Cloud Run / Firebase Hosting** (the `bazinga-app` service): nothing to
  set up. The service account reaches Firestore automatically.
- **On a PC**: install the Google Cloud CLI and run
  `gcloud auth application-default login` once with an account that can access
  `bazingaopens`, then `npm start`.

One-time: Firestore must be enabled in the bazingaopens project (Firebase
console → Firestore Database → Create database).

## Recommended

Each job shows a **Recommended** list below Candidates: applicants from the
lobby app (2026Lobby) whose shift, pay, location and skills fit the job, with a
match score out of 100. Hover a name for phone, email and why they matched. The
list updates live as the lobby app's pools change.

For the lobby app to read jobs and write Recommended, give its service account
access to this project once:

```bash
gcloud projects add-iam-policy-binding bazingaopens \
  --member="serviceAccount:project-877472760654383082@appspot.gserviceaccount.com" \
  --role="roles/datastore.user"
```
