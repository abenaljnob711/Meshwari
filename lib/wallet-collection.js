'use strict';

class WalletCollectionError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = 'WalletCollectionError';
    this.status = status;
  }
}

function canonicalAmount(value) {
  const raw = String(value ?? '').trim();
  if (!/^\\d+(?:\\.\\d{1,4})?$/.test(raw)) return null;
  const [whole, fraction = ''] = raw.split('.');
  return whole.replace(/^0+(?=\\d)/, '') + (fraction ? '.' + fraction.replace(/0+$/, '') : '');
}

async function recordDriverCashCollection(pool, input) {
  const referenceKey = 'cash-collection:' + input.requestKey;
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      `SELECT id,driver_id,amount,balance_after,transaction_type,description,
              reference_key,created_by,currency_code
       FROM mesh_driver_wallet_transactions WHERE reference_key=$1 FOR UPDATE`,
      [referenceKey]
    );
    if (previous.rowCount) {
      const row = previous.rows[0];
      const same = Number(row.driver_id) === input.driverId &&
        canonicalAmount(row.amount) === canonicalAmount(input.amount) &&
        row.currency_code === input.currencyCode &&
        row.description === input.description &&
        String(row.created_by) === String(input.adminId) &&
        row.transaction_type === 'cash_collection';
      if (!same) throw new WalletCollectionError('مفتاح التحصيل مستخدم لعملية مختلفة',409);
      await client.query('COMMIT');
      committed = true;
      const current = await pool.query(
        `SELECT balance AS wallet_balance,withdrawable_balance,currency_code
         FROM mesh_driver_wallet_accounts WHERE driver_id=$1 AND currency_code=$2`,
        [input.driverId,input.currencyCode]
      );
      return {wallet:current.rows[0],transaction:row,replayed:true};
    }

    const driver = await client.query(
      `SELECT d.account_id FROM mesh_driver_profiles d
       JOIN mesh_accounts a ON a.id=d.account_id
       WHERE d.account_id=$1 AND a.role='driver' AND a.status='active'
         AND a.lifecycle_state='open' FOR UPDATE OF d,a`,
      [input.driverId]
    );
    if (!driver.rowCount) throw new WalletCollectionError('السائق غير موجود أو غير نشط',404);

    const wallet = await client.query(
      `SELECT balance,withdrawable_balance FROM mesh_driver_wallet_accounts
       WHERE driver_id=$1 AND currency_code=$2 FOR UPDATE`,
      [input.driverId,input.currencyCode]
    );
    if (!wallet.rowCount) throw new WalletCollectionError('لا توجد محفظة بهذه العملة للسائق',404);
    const debt = Number(wallet.rows[0].balance);
    const amount = Number(input.amount);
    if (!Number.isFinite(debt) || debt >= 0 || !Number.isFinite(amount) || amount <= 0 || amount > Math.abs(debt) + 1e-8) {
      throw new WalletCollectionError('مبلغ التحصيل يجب ألا يتجاوز المديونية القائمة بالعملة نفسها',409);
    }

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
       VALUES($1,$2,$3,'cash_collection',$4,$5,$6,$7)
       RETURNING id,driver_id,amount,balance_after,transaction_type,description,
                 reference_key,created_by,created_at,currency_code`,
      [input.driverId,input.amount,updated.rows[0].wallet_balance,input.description,
       referenceKey,input.adminId,input.currencyCode]
    );
    await client.query(
      `INSERT INTO mesh_audit_logs(actor_id,action,target_id,details)
       VALUES($1,'driver_wallet_cash_collection',$2,$3::jsonb)`,
      [input.auditActorId,input.driverId,JSON.stringify({
        amount:input.amount,currencyCode:input.currencyCode,
        transactionId:entry.rows[0].id,referenceKey,description:input.description
      })]
    );
    await client.query('COMMIT');
    committed = true;
    return {wallet:updated.rows[0],transaction:entry.rows[0],replayed:false};
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
        const row = previous.rows[0];
        if (Number(row.driver_id) === input.driverId &&
            canonicalAmount(row.amount) === canonicalAmount(input.amount) &&
            row.currency_code === input.currencyCode &&
            row.description === input.description &&
            String(row.created_by) === String(input.adminId) &&
            row.transaction_type === 'cash_collection') {
          const current = await pool.query(
            `SELECT balance AS wallet_balance,withdrawable_balance,currency_code
             FROM mesh_driver_wallet_accounts WHERE driver_id=$1 AND currency_code=$2`,
            [input.driverId,input.currencyCode]
          );
          return {wallet:current.rows[0],transaction:row,replayed:true};
        }
        throw new WalletCollectionError('مفتاح التحصيل مستخدم لعملية مختلفة',409);
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {recordDriverCashCollection,WalletCollectionError,canonicalAmount};
