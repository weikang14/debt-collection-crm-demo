const bcrypt = require('bcryptjs');
const dayjs = require('dayjs');
const { db, init, run } = require('./index');
const { recomputeOutstanding } = require('../services/payments');
const { maturityDate } = require('../utils/installments');

const hash = (pw) => bcrypt.hashSync(pw, 8);
const ago = (d) => dayjs().subtract(d, 'day').format('YYYY-MM-DD HH:mm:ss');
const inDays = (d) => dayjs().add(d, 'day').format('YYYY-MM-DD');

const AGENTS = [
  ['Lim Wei Sheng', '012-3456789', 'Consumer', 500000, 5],
  ['Nurul Ain', '013-2233445', 'Consumer', 450000, 5],
  ['Rajesh Kumar', '016-7788990', 'Commercial', 700000, 6],
  ['Tan Mei Ling', '017-5566778', 'Legal', 300000, 4],
];
const CLIENTS = [
  ['Sinar Consumer Credit Sdn Bhd','Ms. Chong','03-77001122','ar@sinar.my','AGR-2023-001',15],
  ['DriveMax Auto Financing','Mr. Fauzi','03-88002233','collections@drivemax.my','AGR-2023-002',12],
  ['CardOne Bank Berhad','Ms. Priya','03-99003344','recovery@cardone.my','AGR-2022-118',18],
  ['GreenVista Property Mgmt','Mr. Lee','03-66004455','admin@greenvista.my','AGR-2024-045',10],
  ['QuickCash Microloans','Ms. Siti','03-55005566','ops@quickcash.my','AGR-2024-060',20],
];
const DEBTORS = [
  ['Ahmad bin Ismail','880101-14-5501','','019-1112223','ahmad@mail.my','12 Jln Bunga, KL','ABC Sdn Bhd',4200,'high','Ismail bin Omar','019-9990001'],
  ['Sarah Lim','900215-10-5522','','012-2223334','sarah.l@mail.my','8 Jln Mawar, PJ','Retail Co',3500,'medium','Lim Ah Kow','012-8880002'],
  ['Ravi Chandran','850320-08-5533','','016-3334445','ravi@mail.my','5 Lorong Melur, Ipoh','Tech Sol',6800,'low','',''],
  ['Nadia Hassan','920510-14-5544','','017-4445556','nadia@mail.my','21 Jln Kenanga, KL','','2800','high','Hassan bin Ali','017-7770003'],
  ['Wong Kar Wai','780612-05-5555','','013-5556667','wong@mail.my','3 Jln Cempaka, JB','WKW Trading',9500,'medium','',''],
  ['Farah Aziz','950701-14-5566','','018-6667778','farah@mail.my','7 Jln Teratai, KL','Clinic MY',5200,'low','Aziz bin Rahman','018-6660004'],
  ['Tan Boon Huat','830825-07-5577','','019-7778889','tanbh@mail.my','15 Jln Anggerik, Penang','',4000,'high','',''],
  ['Kavitha Nair','890903-10-5588','','012-8889990','kavitha@mail.my','9 Jln Seroja, PJ','Nair Ent',7100,'medium','Nair Suresh','012-5550005'],
  ['Muhammad Faiz','910128-14-5599','','016-9990001','faiz@mail.my','2 Jln Dahlia, KL','',3300,'high','Zainab bt Yusof','016-3330006'],
  ['Lee Chong Wei','870417-05-5610','','017-1011121','lcw@mail.my','18 Jln Melati, JB','LCW Sports',12000,'low','',''],
  ['Aisyah Rahman','930922-14-5621','','018-2022232','aisyah@mail.my','6 Jln Kemuning, KL','',2600,'medium','Rahman bin Salleh','018-2220007'],
  ['Ganesh Pillai','800511-08-5632','','019-3033343','ganesh@mail.my','11 Jln Cendana, Ipoh','GP Logistics',8800,'high','',''],
];
const STATUSES = ['new','assigned','negotiation','ptp','partial_paid','fully_paid','legal','closed','cancelled','bankruptcy','deceased','new','assigned','negotiation','ptp','partial_paid','legal','fully_paid','assigned','negotiation'];
const PRIOS = ['low','medium','high','urgent'];

function clearAllTables() {
  init();
  for (const t of ['audit_logs','call_logs','commission_settlements','tasks','ptps','payments','timeline_events','cases','debtors','agents','clients','users']) {
    db.exec(`DELETE FROM ${t}`);
    db.exec(`DELETE FROM sqlite_sequence WHERE name='${t}'`);
  }
}

// Idempotent: safe to call when some demo rows already exist (parents use fixed
// IDs + INSERT OR IGNORE). Never touches users or is_demo=0 (customer) rows.
function insertDemoRows() {
  init();
  AGENTS.forEach((a, i) => run('INSERT OR IGNORE INTO agents (id,name,contact,department,target_amount,commission_rate,is_demo) VALUES (?,?,?,?,?,?,1)', [i + 1, ...a]));
  CLIENTS.forEach((c, i) => run('INSERT OR IGNORE INTO clients (id,company_name,pic_name,phone,email,agreement_no,commission_rate,is_demo) VALUES (?,?,?,?,?,?,?,1)', [i + 1, ...c]));
  DEBTORS.forEach((d, i) => run('INSERT OR IGNORE INTO debtors (id,name,ic_passport,company,phone,email,address,employer,salary,risk_level,guarantor_name,guarantor_phone,is_demo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)', [i + 1, ...d]));

  const year = dayjs().year();
  STATUSES.forEach((st, i) => {
    const id = i + 1;
    // Demo case numbers use a "D" namespace (CASE-YYYY-D001) that customer
    // numbering (CASE-YYYY-0001) never generates. This keeps the two data sets
    // disjoint so "reload demo" can't collide with a trial case that reused a
    // low number after the demo was deleted (was a UNIQUE+FK crash).
    const case_no = `CASE-${year}-D${String(id).padStart(3, '0')}`;
    const client_id = (i % 5) + 1;
    const debtor_id = (i % 12) + 1;
    const agent_id = st === 'new' ? null : (i % 4) + 1;
    const principal = 2000 + (i * 850) % 15000;
    const interest = Math.round(principal * 0.08);
    let outstanding = principal + interest;
    if (st === 'fully_paid') outstanding = 0;
    else if (st === 'partial_paid') outstanding = Math.round((principal + interest) * 0.5);
    run(`INSERT OR IGNORE INTO cases (id,case_no,client_id,debtor_id,agent_id,principal_amount,interest_amount,outstanding_amount,priority,status,opened_at,closed_at,is_demo)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)`,
      [id, case_no, client_id, debtor_id, agent_id, principal, interest, outstanding, PRIOS[i % 4], st, ago(60 - i),
       ['fully_paid','closed','cancelled'].includes(st) ? ago(5) : null]);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by,is_demo) VALUES (?,?,?,?,1)', [id, 'note', `Case opened, status ${st}`, 'System']);
    // A few open, payment-free cases get a monthly-rate 12-month loan so the
    // Repayment Schedule (src/utils/schedule.js) has demo data to show.
    if (id % 2 === 0 && ['new', 'assigned', 'negotiation', 'ptp'].includes(st)) {
      const start = ago(60 - i).slice(0, 10);
      run(`UPDATE cases SET interest_mode='monthly', interest_rate=1.5, interest_from=?, loan_start_date=?, tenure=12, tenure_unit='months', maturity_date=? WHERE id=?`,
        [start, start, maturityDate(start, 12, 'months'), id]);
      recomputeOutstanding(id);
    }
  });

  // Payments for demo partial_paid / fully_paid cases only (is_demo=1 guard)
  db.prepare("SELECT id,principal_amount,interest_amount,status FROM cases WHERE is_demo=1 AND status IN ('partial_paid','fully_paid')").all().forEach((c, idx) => {
    const total = c.principal_amount + c.interest_amount;
    const amt = c.status === 'fully_paid' ? total : Math.round(total * 0.5);
    // Demo receipts use a "D" namespace (RCPT-YYYY-D001) so they can't collide
    // with customer receipts. nextReceiptNo (MAX+1) reads substr→INTEGER, and
    // 'D001' casts to 0, so demo rows never inflate the customer sequence —
    // exactly how demo case numbers (CASE-YYYY-D001) work.
    run('INSERT OR IGNORE INTO payments (case_id,receipt_no,payment_date,amount,method,reference,bank,created_by,is_demo) VALUES (?,?,?,?,?,?,?,?,1)',
      [c.id, `RCPT-${year}-D${String(idx + 1).padStart(3, '0')}`, ago(10), amt, 'bank_transfer', 'TXN' + (1000 + idx), 'Maybank', 'Finance Officer']);
    run('INSERT OR IGNORE INTO timeline_events (case_id,event_type,content,created_by,is_demo) VALUES (?,?,?,?,1)', [c.id, 'payment', `Payment received RM ${amt.toFixed(2)}`, 'Finance Officer']);
  });

  const ptpSeed = [[4,3000,inDays(5),'pending'],[3,2500,ago(3),'broken'],[5,4000,ago(15),'fulfilled'],[14,1800,inDays(10),'pending']];
  ptpSeed.forEach((p) => {
    run('INSERT INTO ptps (case_id,amount,due_date,status,created_by,is_demo) VALUES (?,?,?,?,?,1)', [...p, 'Agent']);
    run('INSERT INTO timeline_events (case_id,event_type,content,created_by,is_demo) VALUES (?,?,?,?,1)', [p[0], p[3] === 'broken' ? 'ptp_broken' : p[3] === 'fulfilled' ? 'ptp_fulfilled' : 'ptp_created', `PTP RM ${p[1]} due ${p[2]}`, 'Agent']);
  });

  const callSeed = [[2,1,180,'answered'],[3,2,0,'no_answer'],[4,1,60,'refused'],[7,3,240,'answered'],[13,2,0,'busy'],[16,4,90,'answered']];
  callSeed.forEach((c) => run('INSERT INTO call_logs (case_id,agent_id,duration_seconds,result,notes,is_demo) VALUES (?,?,?,?,?,1)', [...c, 'Follow-up call']));

  const taskSeed = [[2,1,'follow_up','Call debtor re: overdue',inDays(1),'pending'],[3,2,'visit','Field visit to address',ago(1),'pending'],[7,3,'legal','Prepare LOD',inDays(3),'pending'],[5,1,'reminder','Send WhatsApp reminder',inDays(0),'done']];
  taskSeed.forEach((t) => run('INSERT INTO tasks (case_id,agent_id,type,title,due_date,status,is_demo) VALUES (?,?,?,?,?,?,1)', t));

  const period = dayjs().format('YYYY-MM');
  run('INSERT INTO commission_settlements (agent_id,period,amount,note,settled_by,is_demo) VALUES (?,?,?,?,?,1)', [1, period, 300, 'Partial payout', 'Collection Manager']);
  run('INSERT INTO commission_settlements (agent_id,period,amount,note,settled_by,is_demo) VALUES (?,?,?,?,?,1)', [3, period, 150, 'Advance', 'Collection Manager']);
}

function insertDemoUsers() {
  init();
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['admin',hash('admin123'),'System Admin','admin',null,null]);
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['manager',hash('manager123'),'Collection Manager','manager',null,null]);
  ['agent1','agent2','agent3'].forEach((u,i)=>run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', [u,hash('agent123'),AGENTS[i][0],'agent',i+1,null]));
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['finance',hash('finance123'),'Finance Officer','finance',null,null]);
  run('INSERT INTO users (username,password_hash,full_name,role,agent_id,client_id) VALUES (?,?,?,?,?,?)', ['auditor',hash('auditor123'),'Compliance Auditor','auditor',null,null]);
  run("INSERT INTO audit_logs (username,action,entity_type,entity_id,details) VALUES ('admin','seed','system',NULL,'Demo data seeded')");
}

function seedDemo() {
  clearAllTables();
  insertDemoRows();
  insertDemoUsers();
}

// Delete demo (is_demo=1) rows child->parent, but keep any demo parent still
// referenced by non-demo (customer) rows so nothing breaks. Does NOT reset
// sqlite_sequence, so customer IDs stay above the demo ID range.
function deleteDemo() {
  init();
  for (const t of ['timeline_events', 'call_logs', 'tasks', 'ptps', 'payments', 'commission_settlements']) {
    run(`DELETE FROM ${t} WHERE is_demo=1`);
  }
  run(`DELETE FROM cases WHERE is_demo=1
    AND id NOT IN (SELECT case_id FROM payments)
    AND id NOT IN (SELECT case_id FROM ptps)
    AND id NOT IN (SELECT case_id FROM tasks WHERE case_id IS NOT NULL)
    AND id NOT IN (SELECT case_id FROM call_logs)
    AND id NOT IN (SELECT case_id FROM timeline_events)`);
  run(`DELETE FROM debtors WHERE is_demo=1 AND id NOT IN (SELECT debtor_id FROM cases)`);
  run(`DELETE FROM agents  WHERE is_demo=1 AND id NOT IN (SELECT agent_id FROM cases WHERE agent_id IS NOT NULL)`);
  run(`DELETE FROM clients WHERE is_demo=1 AND id NOT IN (SELECT client_id FROM cases)`);
}

module.exports = { seedDemo, clearAllTables, insertDemoRows, deleteDemo };

if (require.main === module) {
  seedDemo();
  console.log('Seed complete: 7 users, 5 clients, 12 debtors, 4 agents, 20 cases + related data.');
}
