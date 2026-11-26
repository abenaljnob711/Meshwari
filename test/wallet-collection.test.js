'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {recordDriverCashCollection,canonicalAmount} = require('../lib/wallet-collection');

test('canonicalAmount normalizes decimals without changing precision value',()=>{
  assert.equal(canonicalAmount('0012.3400'),'12.34');
  assert.equal(canonicalAmount('0.0000'),'0');
  assert.equal(canonicalAmount('1.12345'),null);
  assert.equal(canonicalAmount('-2'),null);
});

test('cash collection reduces only the selected currency debt and writes audit ledger',async()=>{
  const calls=[];
  const client={
    async query(sql,params=[]){
      calls.push({sql:String(sql),params});
      const q=String(sql);
      if(q==='BEGIN'||q==='COMMIT'||q==='ROLLBACK')return {rowCount:0,rows:[]};
      if(q.includes('FROM mesh_driver_wallet_transactions WHERE reference_key=$1 FOR UPDATE'))return {rowCount:0,rows:[]};
      if(q.includes('FROM mesh_driver_profiles d'))return {rowCount:1,rows:[{account_id:7}]};
      if(q.includes('FROM mesh_driver_wallet_accounts')&&q.includes('FOR UPDATE'))return {rowCount:1,rows:[{balance:'-100.0000',withdrawable_balance:'0'}]};
      if(q.includes('UPDATE mesh_driver_wallet_accounts')) {
        assert.match(q,/balance < 0 AND \$3::numeric <= ABS\(balance\)/);
        return {rowCount:1,rows:[{wallet_balance:'-60.0000',withdrawable_balance:'0',currency_code:'USD'}]};
      }
      if(q.includes('INSERT INTO mesh_driver_wallet_transactions'))return {rowCount:1,rows:[{id:91,driver_id:7,amount:'40',balance_after:'-60',transaction_type:'cash_collection',currency_code:'USD'}]};
      if(q.includes('INSERT INTO mesh_audit_logs'))return {rowCount:1,rows:[]};
      throw new Error('Unexpected SQL: '+q);
    },
    release(){}
  };
  const pool={connect:async()=>client,query:async()=>({rowCount:1,rows:[{wallet_balance:'-60',withdrawable_balance:'0',currency_code:'USD'}]})};
  const result=await recordDriverCashCollection(pool,{
    driverId:7,amount:'40.0000',currencyCode:'USD',description:'Cash received',
    requestKey:'123e4567-e89b-42d3-a456-426614174000',adminId:'admin',auditActorId:1
  });
  assert.equal(result.wallet.wallet_balance,'-60');
  assert.equal(result.transaction.transaction_type,'cash_collection');
  assert.equal(result.replayed,false);
  const update=calls.find(x=>x.sql.includes('UPDATE mesh_driver_wallet_accounts'));
  assert.deepEqual(update.params,[7,'USD','40.0000']);
  assert.ok(calls.some(x=>x.sql.includes('INSERT INTO mesh_audit_logs')));
  assert.equal(calls.at(-1).sql,'COMMIT');
});

test('cash collection refuses amount larger than currency-specific debt',async()=>{
  const client={
    async query(sql){
      const q=String(sql);
      if(q==='BEGIN'||q==='ROLLBACK')return {rowCount:0,rows:[]};
      if(q.includes('FROM mesh_driver_wallet_transactions WHERE reference_key=$1 FOR UPDATE'))return {rowCount:0,rows:[]};
      if(q.includes('FROM mesh_driver_profiles d'))return {rowCount:1,rows:[{account_id:7}]};
      if(q.includes('FROM mesh_driver_wallet_accounts')&&q.includes('FOR UPDATE'))return {rowCount:1,rows:[{balance:'-10',withdrawable_balance:'0'}]};
      throw new Error('Unexpected SQL: '+q);
    },release(){}
  };
  const pool={connect:async()=>client};
  await assert.rejects(()=>recordDriverCashCollection(pool,{
    driverId:7,amount:'11',currencyCode:'USD',description:'Too much',
    requestKey:'123e4567-e89b-42d3-a456-426614174001',adminId:'admin',auditActorId:1
  }),/مبلغ التحصيل/);
});
