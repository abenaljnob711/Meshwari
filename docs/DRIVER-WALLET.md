# Driver wallet

The driver application now exposes the current wallet balance and a transaction history. The API stores a signed amount and resulting balance for each ledger entry. Existing non-zero balances are imported as a one-time opening-balance entry when the database migration runs.

Administrators can make an explicitly described, audited wallet adjustment through the driver account list. Positive amounts add to the wallet; negative amounts deduct from it. This is a manual control and is not a substitute for the approved automatic trip-settlement policy.

## Financial rules still requiring configuration

The codebase does not currently contain a confirmed commission percentage/amount, nor a country-specific currency and payment-provider configuration sufficient to post automatic trip commissions safely. Do not infer these values or start deducting money automatically.

The approved business rules to preserve when settlement is completed are:

- For cash trips, record the company's commission as a driver debt/negative wallet balance and recover it through cash collection, wallet top-ups, or deductions from later electronic earnings.
- For electronic trips, collect payment through the active payment provider for that country, deduct the company's commission, and settle the driver's net amount.
- Yemen defaults to cash, but the administration must be able to enable electronic payments for Yemen; it must not be hard-coded as an exception.
- Currency, payment enablement, commission, and settlement must be configured per country.

Before automatic settlement is enabled, define the commission value and settlement/withdrawal rules for every active country, then add integration tests for cash debt, top-ups, electronic withholding, reversals, and idempotent trip settlement.
