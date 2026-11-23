# Financial settlement design (proposal — not implemented)

Status: design review only. No database migration, payment integration, wallet mutation, deployment, or production data change is included in this document.

## 1. Current verified baseline

- Database schema creation and legacy adjustments are currently concentrated in `initDb()` in `server.js`; there is no dedicated versioned migration directory or migration ledger.
- `mesh_driver_profiles.wallet_balance` and `withdrawable_balance` are existing monetary fields and must be preserved.
- `mesh_driver_wallet_transactions` is the driver ledger. It stores signed amounts and `balance_after`; `reference_key` is unique. Existing non-zero wallet balances are imported as one-time `opening_balance` entries.
- The admin adjustment route updates `wallet_balance` and inserts its ledger row in the same database transaction. It does not update `withdrawable_balance`.
- The trip creation route currently stores fare and route coordinates, but does not persist country, currency, payment method, or the financial policy snapshot used at booking.
- Trip coverage checks pickup, stops, and destination for service availability, but do not currently require all points to resolve to the same country.
- The admin trip-payment route only records an administrative `paid/unpaid` confirmation. It does not charge a payment provider.
- The current wallet documentation explicitly says automatic trip settlement is not implemented.

## 2. Goals and invariants

1. Preserve all existing account IDs, trip records, wallet balances, opening-balance rows, admin adjustments, and audit history.
2. Never infer a commission rate, currency, payment provider, or withdrawal rule.
3. Make each trip's financial terms immutable after booking, even if an administrator later changes country settings.
4. Ensure every financial posting is atomic, auditable, and idempotent.
5. Do not represent an admin's manual collection confirmation as an electronic charge.
6. Keep cash and electronic settlement paths distinct.
7. Do not enable automatic settlement until real payment-provider callbacks/webhooks, reconciliation, refunds, and integration tests are implemented.

## 3. Country and cross-border policy

### Proposed conservative launch rule — approval still required

Reject a trip if pickup, any stop, and destination resolve to different country codes. Also reject a trip whose points cannot be assigned to one unambiguous country when country coverage data is configured for financial operations.

The same-country check must be applied to every point in the existing `requestedPoints` list, not only pickup and destination. Overlapping polygons that produce multiple country matches must be treated as ambiguous and rejected for financial booking until the boundary data is corrected.

Cross-border trips can be introduced later only with an explicit policy defining the pricing currency, commission jurisdiction, payment provider, tax treatment, driver settlement currency, and FX conversion source/rate/time. No implicit currency conversion is allowed.

This is a proposed policy, not yet an approved product decision. Until approval and implementation, automatic financial settlement remains disabled.

## 4. Proposed schema additions (names are provisional)

### Country financial policy

A country policy table should contain at least:
- `country_code` (FK to `mesh_service_countries`, unique)
- `currency_code` (ISO 4217)
- `cash_enabled`, `electronic_enabled`
- commission mode and value (fixed amount or percentage; exactly one valid mode)
- payment provider identifier and provider configuration reference (never raw secrets)
- settlement/withdrawal policy and any minimum/maximum constraints
- `enabled`, effective timestamps, created/updated actor metadata, and version

Validate that at least one payment method is enabled for an active country, and that electronic payments cannot be enabled without a configured provider and verified webhook path. Yemen should default to cash, but the same admin-controlled electronic-payment switch must be available there.

### Immutable trip financial snapshot

Add nullable fields for legacy compatibility:
- `country_code`
- `currency_code`
- `payment_method` (`cash` or `electronic`)
- policy version/reference
- commission mode/value snapshot and calculated commission amount
- fare/pricing configuration snapshot
- explicit settlement state and provider payment reference where applicable

New trips must store a complete snapshot in the same transaction as trip creation. Existing trips must remain explicitly marked as legacy/unknown until reconciled; do not backfill a country, currency, or payment method by guessing from current settings or current coordinates.

### Financial ledger

Prefer a dedicated immutable trip-settlement ledger, or a rigorously typed extension of the existing wallet ledger, with:
- unique idempotency key per trip + posting type + version
- driver, trip, country, currency, signed amount, posting type
- source/provider reference, reversal reference, actor, timestamps, and audit metadata

Do not mix currencies in a single numeric wallet balance. If drivers can earn in multiple currencies, use per-currency balances/ledgers and display the currency explicitly. The existing wallet balance cannot safely represent multiple currencies without a migration and product decision.

## 5. Posting rules

### Cash trips

When the trip is completed and its fare collection is confirmed under the approved process, post the company's commission as a driver debt (negative wallet movement). Recover it through cash collection, driver top-ups, or deductions from later electronic earnings. Do not post on a client-only status update without server-side validation and a single idempotent settlement transaction.

### Electronic trips

Create a payment intent with the configured country provider; verify signed provider webhooks server-side; reconcile amount, currency, trip, and provider reference; then post gross collection, commission, and driver net settlement atomically in the internal ledger. Never trust a client-supplied `paid` flag as proof of payment.

### Reversals and refunds

Every reversal must be a compensating ledger entry referencing the original posting. Never edit or delete a posted financial entry. Partial refunds, chargebacks, cash disputes, and failed payouts need explicit state transitions and reconciliation records.

### Idempotency and concurrency

Use unique database constraints as the final duplicate guard. Lock the trip row and relevant driver/currency balance row in one transaction. A retry must return the existing posting rather than insert another. External provider calls must not be made while holding a long database transaction; use a durable payment-intent/outbox workflow and reconcile webhook delivery separately.

## 6. Migration and rollout plan

1. Introduce a dedicated versioned migration mechanism before adding financial tables. Each migration must have a stable ID/checksum, run under a database lock, commit atomically, and be recorded only after success. Keep migrations forward-only and idempotent where possible.
2. Inventory and reconcile existing trip and wallet data; produce counts and checksums before and after migration. Do not rewrite historical balances or guess missing trip financial attributes.
3. Add country policy and trip snapshot schema with safe nullable defaults; no automatic settlement is enabled.
4. Add read-only admin screens/API for configuring and previewing country policy, with audit logs and validation.
5. Add ledger posting services with idempotency, reversal support, and transaction-level tests.
6. Integrate one real payment provider at a time, including signed webhooks, duplicate/out-of-order event handling, provider reconciliation, and payout handling.
7. Enable settlement only for a limited approved service area after staging and real-device/provider sandbox tests; keep a global kill switch and a per-country kill switch.

## 7. Required tests before enabling money movement

- Migration against a copy of a populated production-like database; verify every legacy wallet balance and transaction remains unchanged.
- Cash debt posting, driver top-up, cash collection, and deduction from future electronic earnings.
- Electronic success, failure, timeout, duplicate webhook, out-of-order webhook, partial refund, full refund, chargeback, and payout failure.
- Duplicate trip completion and concurrent settlement requests must never double-post.
- Currency isolation: no cross-currency arithmetic or balance mixing.
- Country policy changes after booking must not change the booked trip snapshot.
- Yemen cash default and administrator-enabled electronic mode must follow the same validated provider path.
- Legacy trips without snapshots must never be automatically settled using guessed values.

## 8. Explicit non-goals of this proposal

This document does not implement payment processing, commission calculation, automatic wallet deductions, withdrawal, FX, cross-border travel, or production migrations. Those require approved business values, schema review, provider credentials, and integration tests.
