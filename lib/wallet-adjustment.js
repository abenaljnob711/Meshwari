'use strict';

class WalletAdjustmentError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'WalletAdjustmentError';
    this.status = status;
  }
}

function sameRequest(row, input) {
  return Number(row.driver_id) === input.driverId &&
    Number(row.amount) === input.amount &&
    row.description === input.description &&
    String(row.created_by) === String(input.adminId);
}

async function applyAdminWalletAdjustment(pool, input) {
  const referenceKey = 'admin-adjustment:' + input.requestKey;
  const client = await pool.connect();
  let committed = false;

  try {
    await client.query('BEGIN');

    const previous = await client.query(
      `SELECT id,driver_id,amount,balance_after,transaction_type,description,created_by,created_at
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
        'SELECT wallet_balance,withdrawable_balance FROM mesh_driver_profiles WHERE account_id=$1',
        [input.driverId]
      );
      return {
        wallet: current.rows[0] || { wallet_balance: previous.rows[0].balance_after },
        transaction: previous.rows[0],
        replayed: true
      };
    }

    const updated = await client.query(
      `UPDATE mesh_driver_profiles d SET wallet_balance=d.wallet_balance+$1
       FROM mesh_accounts a WHERE d.account_id=$2 AND a.id=d.account_id AND a.role='driver'
       AND a.status='active' AND a.lifecycle_state='open'
       RETURNING d.wallet_balance,d.withdrawable_balance`,
      [input.amount, input.driverId]
    );

    if (!updated.rowCount) {
      throw new WalletAdjustmentError('السائق غير موجود أو غير نشط', 404);
    }

    const entry = await client.query(
      `INSERT INTO mesh_driver_wallet_transactions
       (driver_id,amount,balance_after,transaction_type,description,reference_key,created_by)
       VALUES($1,$2,$3,'admin_adjustment',$4,$5,$6)
       RETURNING id,driver_id,amount,balance_after,transaction_type,description,reference_key,created_by,created_at`,
      [input.driverId, input.amount, updated.rows[0].wallet_balance, input.description, referenceKey, input.adminId]
    );

    await client.query(
      `INSERT INTO mesh_audit_logs (actor_id, action, target_id, details)
       VALUES ($1, 'driver_wallet_adjustment', $2, $3::jsonb)`,
      [input.auditActorId, input.driverId, JSON.stringify({
        amount: input.amount,
        description: input.description,
        transactionId: entry.rows[0].id,
        referenceKey
      })]
    );

    await client.query('COMMIT');
    committed = true;
    return { wallet: updated.rows[0], transaction: entry.rows[0], replayed: false };
  } catch (error) {
    if (!committed) {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }

    // The unique reference_key is the final concurrency guard. A competing
    // request may win after our initial lookup; in that case return its result.
    if (error && error.code === '23505') {
      const previous = await pool.query(
        `SELECT id,driver_id,amount,balance_after,transaction_type,description,reference_key,created_by,created_at
         FROM mesh_driver_wallet_transactions WHERE reference_key=$1`,
        [referenceKey]
      );
      if (previous.rowCount) {
        if (!sameRequest(previous.rows[0], input)) {
          throw new WalletAdjustmentError('مفتاح العملية مستخدم مسبقاً لبيانات تسوية مختلفة', 409);
        }
        const current = await pool.query(
          'SELECT wallet_balance,withdrawable_balance FROM mesh_driver_profiles WHERE account_id=$1',
          [input.driverId]
        );
        return {
          wallet: current.rows[0] || { wallet_balance: previous.rows[0].balance_after },
          transaction: previous.rows[0],
          replayed: true
        };
      }
    }
    if (error instanceof WalletAdjustmentError) throw error;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { applyAdminWalletAdjustment, WalletAdjustmentError };
