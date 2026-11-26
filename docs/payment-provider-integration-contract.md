# Meshwari payment-provider certification contract

Electronic payment must remain disabled in a country until a named provider, merchant account, sandbox and production credentials, signed webhook, refund flow and settlement process have all been verified. Do not infer a provider or turn the country switch on merely because a payment option appears in the UI.

## Provider adapter boundary
Implement a separate adapter for each selected provider with these operations:
- create or authorize a payment using an immutable trip ID, idempotency key, amount and ISO currency;
- verify webhook authenticity using the provider's documented signature algorithm and raw request body;
- normalize provider states into pending, authorized, captured, failed, cancelled, refunded and reversed;
- request full or partial refunds and record provider references;
- retrieve or ingest settlement statements for reconciliation.

Never accept a client-supplied "paid" flag. Only a verified provider response or authenticated webhook can advance a payment attempt. Store provider event IDs under a unique constraint and make webhook processing idempotent. Reject stale, malformed, unsigned or mismatched amount/currency/trip events. Preserve the original payload hash and minimal provider metadata for audit; do not store card PAN, CVV or unnecessary personal data.

## Required financial sequence
1. Create the trip with immutable fare, currency, minor-unit and commission snapshots.
2. Create a pending payment attempt with a unique idempotency key.
3. Send the payment request to the provider; record its provider payment ID and normalized status.
4. Verify webhook signature before parsing business state; lock the payment attempt and trip in a database transaction.
5. Apply each provider event once. Capture/collection and the platform commission/driver net must be recorded in the financial ledger exactly once.
6. Reconcile captured transactions, refunds, reversals, provider fees and settlement statements per country and currency.
7. Settle only the driver's verified net payable amount. Never convert between currencies without an explicit, audited FX rate and policy.

## Sandbox certification matrix
- success and delayed success;
- decline and insufficient funds;
- pending payment and late webhook;
- duplicated webhook and out-of-order webhook;
- forged/invalid signature;
- amount, currency, trip or merchant mismatch;
- request timeout and safe idempotent retry;
- full refund, partial refund, refund failure;
- chargeback/reversal;
- provider settlement mismatch and delayed payout.

For every case retain request/response IDs, event IDs, timestamps, expected ledger movements and observed ledger movements. Use provider test cards/tokens only.

## Country policy
- Yemen defaults to cash. Electronic payment remains off unless the administration explicitly enables it after provider certification.
- Other countries may offer cash and electronic methods, but electronic must be gated by the provider's certification for that country.
- A driver's personal bank card or POS terminal is not a prerequisite for accepting a platform-collected electronic trip.
- Cash-trip commission remains a driver debt in the matching currency wallet. Electronic commission must be withheld before driver settlement.

## Release gate
The provider-specific implementation is not complete until the provider is selected and its official documentation and sandbox account are available. Production credentials must be stored only in the approved secret manager. Run all certification cases in sandbox, reconcile provider statements, obtain operations approval, then enable one country at a time. Do not enable live electronic payments based on source code or a successful APK build alone.
