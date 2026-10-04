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

The Firebase web app configuration is in `app.js`. It identifies the Firebase project used by the browser SDK; the web API key and project IDs are client configuration, not Admin credentials. Do not put service-account JSON, private keys, or Admin SDK credentials in this repository.

Before sign-in, enable Google under **Firebase Console → Authentication → Sign-in method** and authorize the preview hostname. The page uses Google popup sign-in. Once signed in, it reads the user's UID and fetches dataset documents from:

```text
users/{uid}/datasets/{datasetId}
```

Each dataset document has a `rows` array unless it is marked `chunked`. For chunked datasets, rows are read from:

```text
users/{uid}/datasets/{datasetId}/chunks/{chunkId}
```

The app reads both dataset documents and chunk subcollections for the signed-in UID; Firestore rules should allow those reads only for the intended signed-in user and deny client writes. The current app expects account documents to belong to the signed-in UID, so the UID in the document path must match that account.

## Firestore datasets

The dashboard reads `portfolio_total`, `account_metadata`, and `sector_definitions`, then discovers account dataset IDs from the `id` (or `accountId`) fields in `account_metadata`. Include a metadata row for each account to load its dataset; `accountName` (or `name`), `brokerage`, and `accountType` provide optional display details. Missing account datasets and optional sector definitions are tolerated. `updatedAt` is optional and is used for the dashboard's update date.

| Dataset document | Rows and fields used |
| --- | --- |
| Account dataset ID from `account_metadata` | One dated row per account history point. Required for useful account history: `date` (ISO date/string or Firestore timestamp) and `daily_acct_total`. Preferred holding shape: one nested object per ticker with `shares`, `avg_cb`, and `px` values (for example, `"AAPL":{"shares":8,"avg_cb":160,"px":188}`). The app also supports the legacy flat fields (`AAPL`, `AAPL_cb`, and `AAPL_px`). `daily_acct_total_cb` may provide the total account cost basis. |
| `portfolio_total` | One dated row per aggregate portfolio history point. `date`; `Portfolio Value` or `portfolio_value`; `Cumulative Return $` or `cumulative_return`; `CB-adj. Return` or `cb_adj_return`; `Spy` or `spy`; `Alpha` or `alpha`; `Alpha Daily - cbadj` or `alpha_daily_cbadj`; and `CB-Adj Daily return` or `cb_adj_daily_return`. The overview KPIs and main portfolio performance chart use this aggregate dataset. |
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

For larger datasets, set `chunked: true` on the dataset document and store its rows in chunk documents with a numeric `chunkIndex` and a `rows` array. The app reads chunks in index order; it uses the chunk rows instead of any parent-document `rows`.

`data/process_data/symbol_prices.csv` is retained as a local data asset; the webpage does not load it.