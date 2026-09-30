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

Each dataset document has a `rows` array. The app performs document reads for the signed-in UID; Firestore rules should allow only the intended signed-in user and deny client writes. The current app expects account documents to belong to the signed-in UID, so the UID in the document path must match that account.

## Firestore datasets

The dashboard requests `account_1` through `account_10`, `portfolio_total`, and `account_metadata`. Every document is optional at read time; absent documents and fields are displayed as blank where possible. `updatedAt` is optional and is used for the dashboard's update date.

| Dataset document | Rows and fields used |
| --- | --- |
| `account_1` … `account_10` | One dated row per account history point. Required for useful account history: `date` (ISO date/string or Firestore timestamp) and `daily_acct_total`. Holdings are represented by one field per ticker for shares (`AAPL`), current price (`AAPL_px`), and average cost per share (`AAPL_cb`). `daily_acct_total_cb` may provide the total account cost basis. The ticker fields repeat for each holding. |
| `portfolio_total` | One dated row per aggregate portfolio history point. `date`; `Portfolio Value` or `portfolio_value`; `Cumulative Return $` or `cumulative_return`; `CB-adj. Return` or `cb_adj_return`; `Spy` or `spy`; `Alpha` or `alpha`; `Alpha Daily - cbadj` or `alpha_daily_cbadj`; and `CB-Adj Daily return` or `cb_adj_daily_return`. The overview KPIs and main portfolio performance chart use this aggregate dataset. |
| `account_metadata` (optional) | One row per account. `id` (or `accountId`) must match an account document ID such as `account_1`. `accountName` (or `name`) supplies its display name; `brokerage` and `accountType` supply the institution and account type. |

Example Firestore document shape:

```json
{
	"rows": [
		{
			"date": "2026-09-28T00:00:00.000Z",
			"AAPL": 8,
			"AAPL_px": 188.0,
			"AAPL_cb": 160.0,
			"daily_acct_total": 1504.0,
			"daily_acct_total_cb": 1280.0
		}
	],
	"rowCount": 1
}
```

`data/process_data/symbol_prices.csv` is retained as a local data asset; the webpage does not load it.
