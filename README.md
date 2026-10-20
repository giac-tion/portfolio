# Port dashboard

This is a static browser dashboard. It uses Firebase Authentication for sign-in and Cloud Firestore for account, portfolio, and optional account metadata.

## Run in Codespaces

1. Open the integrated terminal at the repository root (`/workspaces/portfolio`).
2. Start the static server:

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

3. In the bottom panel, open the **Ports** tab. If port `8000` is not listed, choose **Forward a Port** and enter `8000`.
4. Use the port row's **Open in Browser** button, or click/copy its forwarded address to preview the dashboard.
5. Stop the server with `Ctrl+C` in the terminal when finished.

Keep the forwarded port private. Firebase Authentication must allow the hostname used for the preview. Add that hostname under **Firebase Console → Authentication → Settings → Authorized domains** if Firebase reports `auth/unauthorized-domain`.

## Firebase connection

The Firebase web app configuration is in `firebase.js`. It identifies the Firebase project used by the browser SDK; the web API key and project IDs are client configuration, not Admin credentials. Do not put service-account JSON, private keys, or Admin SDK credentials in this repository.

Before sign-in, enable Google under **Firebase Console → Authentication → Sign-in method** and authorize the preview hostname. The page uses Google popup sign-in. Once signed in, it reads the user's UID and fetches dataset documents from:

```text
users/{uid}/datasets/{datasetId}
```

Current dataset root documents publish metadata and an `activeVersionId`; row data is stored in versioned chunk documents:

```text
users/{uid}/datasets/{datasetId}/versions/{versionId}/chunks/{chunkId}
```

New writes stage deterministic chunk documents beneath a unique version, then update the dataset root's `activeVersionId` last. The version manifest records its chunk count, row count, headers, and version; the root also records `updatedAt`. Existing inline-row and legacy `chunks` datasets remain readable.

Editable broker transaction sources are stored separately at:

```text
users/{uid}/account_sources/{accountId}
```

The app reads data for the signed-in UID. Input Data writes only beneath that user's `users/{uid}` path. Firestore rules must restrict reads and writes to the signed-in owner.

To use Input Data and build aggregation, configure Firestore rules to permit the signed-in owner to create, update, and delete documents beneath `datasets` and `account_sources`, including nested versions and chunks. If the current rules deny a request, Firestore returns `permission-denied`; update and publish rules in Firebase Console → Firestore Database → Rules. Merge scoped rules like these into the existing rules (do not replace unrelated rules or allow public writes):

```text
match /users/{uid}/datasets/{datasetId} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
  match /{nested=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
}

match /users/{uid}/account_sources/{accountId} {
  allow read, write: if request.auth != null && request.auth.uid == uid;
  match /{nested=**} {
    allow read, write: if request.auth != null && request.auth.uid == uid;
  }
}
```

Do not use broad public write rules: the browser client must not be able to access another user's datasets.

## Input Data page

The **Input Data** button opens `input.html`, which provides a spreadsheet-style grid for `account_metadata`, `sector_definitions`, `account_instantiations`, and each account's transaction source. Edit cells, rename columns, paste tab-separated ranges from Excel or Google Sheets, add rows/columns, then click **Submit changes** to save. The last selected dataset is remembered in this browser; account transaction rows are reloaded from the account's saved Firebase source when the page is reopened. Account rows use the broker's source-transaction CSV columns:

| Broker | Required source columns |
| --- | --- |
| Robinhood and UBS | `Activity Date`, `Process Date`, `Settle Date`, `Instrument`, `Description`, `Trans Code`, `Quantity`, `Price`, `Amount` |
| T. Rowe Price | `Date`, `Activity Type`, `Investment`, `Amount`, `Shares`, `Price` |
| Charles Schwab | `Date`, `Action`, `Symbol`, `Description`, `Quantity`, `Price`, `Fees & Comm`, `Amount` |

Raw transaction rows are stored separately under `users/{uid}/account_sources/{accountId}` so aggregation never overwrites its source. Generated daily account ledgers stay under `users/{uid}/datasets/{accountId}`. Account instantiations are editable rows with `accountId`, `symbol`, `mode` (`add`, `replace`, or `set`), `shares`, `total_cost_basis`, and optional `effective_date` (`account_end`, `MM/DD/YYYY`, or `YYYY-MM-DD`). The rules dataset starts empty; enter any existing Python overrides into the grid if you want to retain them.

**Build portfolio data** validates that every account in `account_metadata` has saved transaction rows, processes them using the legacy average-cost behavior, aggregates daily portfolio results, and writes generated ledgers plus `portfolio_total`. Build runs are serialized; an abandoned build lock expires after two hours. It uses the checked-in `data/process_data/symbol_prices.csv` for reproducible security and SPY prices. Charles Schwab `Fees & Comm` is preserved in the source table but ignored by calculations, matching the Python behavior; unrecognized actions use the generic share-change logic.

Datasets are written in versioned chunks of at most about 650 KiB, with Firestore batches limited by payload and operation count. New versions are staged before a dataset's root metadata publishes the version. The portfolio summary records the exact source versions and generated account versions; the overview reads those pinned outputs and marks the build stale after relevant source data or instantiation rules change. Older published versions are cleaned after publication; newer staged versions are preserved.

## Firestore datasets

The dashboard reads `portfolio_total`, `account_metadata`, and `sector_definitions`, then discovers account dataset IDs from the `id` (or `accountId`) fields in `account_metadata`. Include a metadata row for each account to load its generated ledger; `accountName` (or `name`), `brokerage`, and `accountType` provide optional display details. Missing account datasets and optional sector definitions are tolerated. `updatedAt` is used for the build date shown with the overview source-freshness status.

| Dataset document | Rows and fields used |
| --- | --- |
| Account dataset ID from `account_metadata` | One dated row per account history point. Required for useful account history: `date` (ISO date/string or Firestore timestamp) and `daily_acct_total`. Preferred holding shape: one nested object per ticker with `shares`, `avg_cb`, and `px` values (for example, `"AAPL":{"shares":8,"avg_cb":160,"px":188}`). The app also supports the legacy flat fields (`AAPL`, `AAPL_cb`, and `AAPL_px`). `daily_acct_total_cb` may provide the total account cost basis. |
| `portfolio_total` | One dated row per aggregate portfolio history point. `Date`; `Portfolio Value`; `Cumulative Return $`; `CB-adj. Return`; `Spy % return`; `Alpha`; `Alpha Daily - cbadj`; and `Return Daily - cbadj`. The document metadata includes `sourceDatasetVersions` and `accountOutputVersions` used for staleness and consistent overview reads. |
| `account_metadata` | One row per account. `id` (or `accountId`) must match the account dataset ID. `accountName` (or `name`) supplies its display name; `brokerage` and `accountType` supply the institution and account type. |
| `sector_definitions` | One row per sector with a `sector` name and a `symbols` array, such as `{"sector":"Big Tech","symbols":["MSFT","AMZN"]}`. A row may also be a map of sector names to symbol arrays. Symbols not listed, and portfolio value not represented by priced positions, are included in `Other`. If this dataset is absent, all symbols are included in `Other`. |

Example Firestore dataset document with inline rows:

```json
{
	"rows": [
		{
			"date": "2026-09-28T00:00:00.000Z",
			"AAPL": {
				"shares": 8,
				"avg_cb": 160.0,
				"px": 188.0
			},
			"daily_acct_total": 1504.0,
			"daily_acct_total_cb": 1280.0
		}
	],
	"rowCount": 1
}
```

The inline-row example above shows a legacy-compatible dataset. New writes use the versioned chunk layout described above, keeping individual documents below Firestore's size limit.

The returns chart loads SPY daily close prices from Yahoo Finance and rebases them to cumulative percent change over the portfolio's displayed date range. If Yahoo Finance is unavailable or rate-limited, it falls back to the `SPY` column in `data/process_data/symbol_prices.csv`; no SPY rows need to be uploaded to Firestore. The local CSV is a fallback and may be less current than Yahoo Finance.