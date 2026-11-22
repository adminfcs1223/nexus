-- The corrected canonical floor map (Derek, 2026-11-22). Orientation and landmarks as the first Nexus drawing; pallet layout:
--   LEFT / OUTBOUND, by the Exit:   two lines of 18   P-37..P-54 and P-55..P-72   = 36
--   RIGHT / INBOUND, under the Dock: two lines of 15   P-01..P-15 and P-19..P-33   = 30
--   STAGING, lower end of the right side: STG-01 and STG-02 (not counted in the 66)
-- 66 pallet positions + 2 staging = 68 mapped. No code is renumbered: P-16..P-18 and P-34..P-36 keep their identity, are
-- not drawn and accept nothing, so a barcode already printed can never come to mean a different square.
-- Two floors carry this one map: the live floor (occupancy NOT INITIALIZED, assign / move / release off, nothing imported)
-- and its test copy for synthetic pallets.
insert into nexus.warehouses (code, name, test, occupancy_state, moves_enabled, map_version, landmarks) select w.code, w.name, w.test, w.state, w.test, 2,
  '[{"key":"exit","label":"Exit","at":"top-left"},{"key":"dock","label":"Dock","at":"top-right"},{"key":"walkway","label":"Walkway","at":"centre"},{"key":"prep","label":"Prep area","at":"bottom-left"},{"key":"entrance","label":"Entrance","at":"bottom-right"}]'::jsonb
from (values ('HILLSBOROUGH', 'Hillsborough', false, 'not_initialized'), ('HILLSBOROUGH-TEST', 'Hillsborough (test floor, synthetic pallets only)', true, 'synthetic')) w(code, name, test, state);

insert into nexus.locations (code, kind, warehouse, zone, capacity, status, status_reason, map_block, map_col, map_row)
select 'P-' || lpad(n::text, 2, '0'), 'pallet', w.code, side, 1,
  case when drawn then 'open' else 'unavailable' end, case when not drawn then 'Not part of the 66-position layout; the code is kept so it is never reused' end,
  case when drawn then side end, case when drawn then (n - 1) % 36 / 18 + 1 end, case when drawn then (n - 1) % 18 + 1 end
from nexus.warehouses w, generate_series(1, 72) n, lateral (select case when n <= 36 then 'inbound' else 'outbound' end side, (n > 36 or (n - 1) % 18 < 15) drawn) x;
insert into nexus.locations (code, kind, warehouse, zone, capacity, status, map_block, map_col, map_row)
select v.code, v.kind, w.code, v.zone, null, 'open', v.block, v.col, 1 from nexus.warehouses w,
  (values ('STG-01', 'staging', 'staging', 'staging', 1), ('STG-02', 'staging', 'staging', 'staging', 2), ('RCV-DOCK', 'dock', 'receiving', 'dock', 1)) v(code, kind, zone, block, col);
