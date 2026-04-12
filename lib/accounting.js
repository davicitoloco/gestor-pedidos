'use strict';
const { db } = require('../db');

function acctBySubtype(subtype) {
  return db.prepare('SELECT id, code, name FROM accounts WHERE subtype=? AND accepts_movements=1 LIMIT 1').get(subtype);
}

function acctByBankId(bankAccountId) {
  const a = db.prepare('SELECT id, code, name FROM accounts WHERE bank_account_id=? LIMIT 1').get(bankAccountId);
  return a || db.prepare("SELECT id, code, name FROM accounts WHERE subtype='Banco' AND accepts_movements=1 LIMIT 1").get();
}

// Must be called inside withTransaction
function recordJournal({ date, desc, reference, ref_type, ref_id, lines, userId }) {
  const totalD = lines.reduce((s, l) => s + (l.debit  || 0), 0);
  const totalC = lines.reduce((s, l) => s + (l.credit || 0), 0);
  if (Math.abs(totalD - totalC) > 0.005) throw new Error(`Asiento desbalanceado: debe=${totalD.toFixed(2)} haber=${totalC.toFixed(2)}`);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO journal_entries (date, description, reference, ref_type, ref_id, created_by) VALUES (?,?,?,?,?,?)'
  ).run(date || new Date().toISOString().slice(0,10), desc, reference||'', ref_type||'', ref_id||null, userId||null);
  const entryId = Number(lastInsertRowid);
  const ins = db.prepare('INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, line_description) VALUES (?,?,?,?,?)');
  for (const l of lines) ins.run(entryId, l.account_id, l.debit||0, l.credit||0, l.description||'');
  return entryId;
}

module.exports = { acctBySubtype, acctByBankId, recordJournal };
