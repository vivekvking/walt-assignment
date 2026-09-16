import { readFileSync } from 'node:fs';

export const model = JSON.parse(readFileSync(new URL('./model.json', import.meta.url), 'utf8'));
export const contracts = JSON.parse(readFileSync(new URL('./contracts.json', import.meta.url), 'utf8'));
export const schema = readFileSync(new URL('./data.sql', import.meta.url), 'utf8');

export const expected = {
  A: [{ online_rev: 420, total_revenue: 710 }],
  B: [
    { region: 'North', total_revenue_2025: 100, total_revenue_2026: 250, total_revenue_delta: 150, total_revenue_pct_change: 150, is_total: false },
    { region: 'South', total_revenue_2025: 200, total_revenue_2026: 370, total_revenue_delta: 170, total_revenue_pct_change: 85, is_total: false },
    { region: 'West', total_revenue_2025: 150, total_revenue_2026: 90, total_revenue_delta: -60, total_revenue_pct_change: -40, is_total: false },
    { region: null, total_revenue_2025: 450, total_revenue_2026: 710, total_revenue_delta: 260, total_revenue_pct_change: 100 * 260 / 450, is_total: true },
  ],
  C: [
    { region: 'North', order_count: 4, is_total: false },
    { region: 'South', order_count: 3, is_total: false },
    { region: 'West', order_count: 2, is_total: false },
    { region: null, order_count: 8, is_total: true },
  ],
};
