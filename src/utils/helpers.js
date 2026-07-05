const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const money = (n) =>
  Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Stored datetimes are UTC (SQLite datetime('now')). Display in Malaysia time
// (MYT = UTC+8, no daylight saving). dayjs.utc parses the SQLite string as UTC
// reliably regardless of the server's own timezone (local dev or Render/UTC).
const toMYT = (s) => dayjs.utc(s).add(8, 'hour');
const dateFmt = (s) => (s ? toMYT(s).format('YYYY-MM-DD') : '');
const dateTimeFmt = (s) => (s ? toMYT(s).format('YYYY-MM-DD HH:mm') : '');
// "Overdue by how many days" relative to today in Malaysia time (MYT), so the
// server's own timezone (e.g. UTC on Render) doesn't skew the count.
const daysOverdue = (iso) => {
  if (!iso) return 0;
  const todayMYT = dayjs.utc().add(8, 'hour').format('YYYY-MM-DD');
  return Math.max(0, dayjs(todayMYT).diff(dayjs(String(iso).slice(0, 10)), 'day'));
};

const CASE_STATUS = {
  new: ['New', 'is-neutral'], assigned: ['Assigned', 'is-blue'],
  negotiation: ['Negotiation', 'is-blue'], ptp: ['PTP', 'is-gold'],
  partial_paid: ['Partial Paid', 'is-gold'], fully_paid: ['Fully Paid', 'is-green'],
  legal: ['Legal', 'is-red'], closed: ['Closed', 'is-neutral'],
  cancelled: ['Cancelled', 'is-neutral'], bankruptcy: ['Bankruptcy', 'is-red'],
  deceased: ['Deceased', 'is-red'],
};
const caseStatusLabel = (s) => (CASE_STATUS[s] || [s, 'is-neutral'])[0];
const caseStatusClass = (s) => (CASE_STATUS[s] || [s, 'is-neutral'])[1];
// generic aliases for ptp/task/call statuses
const statusLabel = caseStatusLabel;
const statusClass = caseStatusClass;

const ICONS = {
  dashboard: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  clients: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="9" cy="7" r="3"/></svg>',
  debtors: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  cases: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>',
  agents: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="7" r="4"/><path d="M6 21v-2a6 6 0 0 1 12 0v2"/></svg>',
  tasks: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  reports: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  audit: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z"/></svg>',
  search: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>',
  logout: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/></svg>',
  users: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="3"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  demo: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
};
const icon = (name) => ICONS[name] || '';

module.exports = { money, dateFmt, dateTimeFmt, daysOverdue, statusLabel, statusClass, caseStatusLabel, caseStatusClass, icon };
