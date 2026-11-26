'use strict';

class WalletAdjustmentError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'WalletAdjustmentError';
    this.status = status;
  }
}

function canonicalDecimal(value) {
  const raw = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(raw)) return null;
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction = ''] = unsigned.split('.');
  const normalized = whole.replace(/^0+(?=\d)/, '') + (fraction ? '.' + fraction.replace(/0+$/, '') : '');
  const zero = /^0(?:\.0*)?$/.test(normalized);
  return (negative && !zero ? '-' : '') + normalized;
}

function sameRequest(row, input) {
  return Number(row.driver_id) === input.driverId &&
    canonicalDecimal(row.amount) === canonicalDecimal(input.amount) &&
    row.description === input.description &&
    row.currency_code === input.currencyCode &&
    String(row.created_by) === String(input.adminId);
}

async function applyAdminWalletAdjustment(pool, input) {
  const referenceKey = 'admin-adjustment:' + input.requestKey;
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');
    const previous = await client.query(
      `SELECT id,driver_id,amount,balance_after,transaction_type,description,
              reference_key,created_by,created_at,currency_code
       FROM mesh_driver_wallet_transactions WHERE reference_key=$1 FOR UPDATE`,
      [referenceKey]
    );

    if (previous.rowCount) {
      if (!sameRequest(previous.rows[0], input)) {
        throw new WalletAdjustmentError('مفتاح العملية مستخدم مسبقاً لبيانات تسوية مختلفة', 409);
      }
      await client.query('COMMIT');
      committed = true;
      const current = await pool.query(
        `SELECT balance AS wallet_balance,withdrawable_balance,currency_code
         FROM mesh_driver_wallet_accounts WHERE driver_id=$1 AND currency_code=$2`,
        [input.driverId,input.currencyCode]
      );
      return {
        wallet: current.rows[0] || { wallet_balance: previous.rows[0].balance_after, currency_code: input.currencyCode },
        transaction: previous.rows[0],
        replayed: true
      };
    }

    const driver = await client.query(
      `SELECT d.account_id FROM mesh_driver_profiles d
       JOIN mesh_accounts a ON a.id=d.account_id
       WHERE d.account_id=$1 AND a.role='driver' AND a.status='active'
         AND a.lifecycle_state='open' FOR UPDATE OF d,a`,
      [input.driverId]
    );
    if (!driver.rowCount) throw new WalletAdjustmentError('السائق غير موجود أو غير نشط', 404);

    await client.query(
      `INSERT INTO mesh_driver_wallet_accounts(driver_id,currency_code,balance)
       VALUES($1,$2,0) ON CONFLICT(driver_id,currency_code) DO NOTHING`,
      [input.driverId,input.currencyCode]
    );
    const updated = await client.query(
      `UPDATE mesh_driver_wallet_accounts
       SET balance=balance+$3,updated_at=NOW()
       WHERE driver_id=$1 AND currency_code=$2
       RETURNING balance AS wallet_balance,withdrawable_balance,currency_code`,
      [input.driverId,input.currencyCode,input.amount]
    );

    const entry = await client.query(
      `INSERT INTO mesh_driver_wallet_transactions
       (driver_id,amount,balance_after,transaction_type,description,reference_key,created_by,currency_code)
       VALUES($1,$2,$3,'admin_adjustment',$4,$5,$6,$7)
       RETURNING id,driver_id,amount,balance_after,transaction_type,description,
                 reference_key,created_by,created_at,currency_code`,
      [input.driverId,input.amount,updated.rows[0].wallet_balance,input.description,
       referenceKey,input.adminId,input.currencyCode]
    );

    await client.query(
      `INSERT INTO mesh_audit_logs (actor_id, action, target_id, details)
       VALUES ($1, 'driver_wallet_adjustment', $2, $3::jsonb)`,
      [input.auditActorId,input.driverId,JSON.stringify({
        amount:input.amount,currencyCode:input.currencyCode,description:input.description,
        transactionId:entry.rows[0].id,referenceKey
      })]
    );
    await client.query('COMMIT');
    committed = true;
    return { wallet:updated.rows[0],transaction:entry.rows[0],replayed:false };
  } catch (error) {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    if (error && error.code === '23505') {
      const previous = await pool.query(
        `SELECT id,driver_id,amount,balance_after,transaction_type,description,
                reference_key,created_by,created_at,currency_code
         FROM mesh_driver_wallet_transactions WHERE reference_key=$1`,
        [referenceKey]
      );
      if (previous.rowCount) {
        if (!sameRequest(previous.rows[0],input)) {
          throw new WalletAdjustmentError('مفتاح العملية مستخدم مسبقاً لبيانات تسوية مختلفة',409);
        }
        const current = await pool.query(
          `SELECT balance AS wallet_balance,withdrawable_balance,currency_code
           FROM mesh_driver_wallet_accounts WHERE driver_id=$1 AND currency_code=$2`,
          [input.driverId,input.currencyCode]
        );
        return {
          wallet:current.rows[0] || {wallet_balance:previous.rows[0].balance_after,currency_code:input.currencyCode},
          transaction:previous.rows[0],replayed:true
        };
      }
    }
    if (error instanceof WalletAdjustmentError) throw error;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { applyAdminWalletAdjustment, WalletAdjustmentError, canonicalDecimal };
