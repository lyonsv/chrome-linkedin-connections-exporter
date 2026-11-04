# LinkedIn Connections Exporter

A small Chrome extension (Manifest V3) that exports your LinkedIn connections to a CSV file. It has no dependencies and no build step, and it doesn't send data to any server.

| Name | Title | Connection Date | Date Is Approximate | Connected (as shown on LinkedIn) | Profile URL |
|---|---|---|---|---|---|
| Jane Doe | Head of Product at Acme | 2024-03-05 | no | Connected on March 5, 2024 | https://www.linkedin.com/in/jane-doe/ |

## Install

1. Clone this repo.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the repo folder.
4. Pin the extension to your toolbar.

## Usage

1. Open your connections page: <https://www.linkedin.com/mynetwork/invite-connect/connections/>
2. Click the extension icon, then **Start export**.
3. **Keep the LinkedIn tab in front.** Chrome slows down background tabs, so the export pauses (and says so) while the tab is hidden. You can close the popup.
4. When it finishes, `linkedin-connections-YYYY-MM-DD.csv` downloads automatically.

If the run stops early, you get `linkedin-connections-YYYY-MM-DD-PARTIAL.csv` and an explanation in the popup. **Download CSV** in the popup always re-downloads the last run.

## Error handling

The exporter is designed to fail loudly instead of quietly giving you an incomplete file.

| Situation | What you see |
|---|---|
| No connection cards found (LinkedIn changed its HTML, or the UI isn't in English) | Error with diagnostics (how many profile links were found on the page) |
| Pagination stops before the total shown in the page header | "Collected X of Y" error with the likely cause; partial CSV downloaded |
| Rate-limit / "Something went wrong" banner on the page | Error naming it; partial CSV downloaded |
| Redirected to a login or security checkpoint, or tab navigated away | Error explaining what happened and what to do |
| Tab closed or reloaded mid-export | Popup detects the missing heartbeat ("stalled") and offers the saved rows |
| Many rows missing name, title or date | Warning that the HTML for that field has probably changed |
| Unexpected exception | Error message and stack, plus a **Copy diagnostics** button for bug reports |

## How it works

LinkedIn's class names are obfuscated and change often, so the scraper doesn't rely on them:

1. It finds every `/in/<slug>` profile link on the page.
2. For each one, it walks up the DOM to the nearest element that contains **"Connected …"** text and links to exactly one person. That element is the card.
3. It extracts name, title and date from the card. Known legacy class names are tried first, and text heuristics are the fallback.
4. It clicks **Show more results** or scrolls to load more. It harvests cards as they appear, so lists that remove off-screen items still work. It stops when the header total is reached or several retries produce nothing new.

Dates like "Connected 3 weeks ago" are turned into an estimated date and flagged in the **Date Is Approximate** column.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `popup.html` / `popup.js` / `popup.css` | UI: starts or stops the export, shows progress and errors, re-downloads the CSV |
| `content.js` | Injected into the LinkedIn tab: scraping, pagination, error detection |
| `lib.js` | Pure helpers (CSV building, date parsing, URL normalisation), testable in Node |

## Limitations and notes

- Requires the LinkedIn UI to be in **English** (it looks for the "Connected" label).
- LinkedIn's header count often includes deactivated or hidden members, so a small shortfall (about 1%) is treated as complete, with a warning.
- Automated scraping is against [LinkedIn's User Agreement](https://www.linkedin.com/legal/user-agreement). This tool uses your own logged-in session at normal browsing speed, but use it at your own risk. LinkedIn's official export (**Settings → Data privacy → Get a copy of your data → Connections**) has no such risk and is a good way to cross-check the results.
- Exported CSVs contain other people's personal data. They're ignored by `.gitignore`, so keep them out of version control.
