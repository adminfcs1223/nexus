-- The final approved floor map (warehouse owner's corrected sketch, 2026-11-22). It supersedes every earlier numbering;
-- earlier positions and occupancy were tests and are not carried over.
--   RIGHT / INBOUND, under the Dock:  P-01..P-15 and P-16..P-30, top to bottom
--   LEFT / OUTBOUND, by the Exit:     P-31..P-48 and P-49..P-66, top to bottom
--   STAGING: STG-01 and STG-02 side by side at the lower right (not counted in the 66)
-- 66 consecutive pallet positions, 2 staging spots, no gaps and no inactive codes.
-- One grid places everything: x 1-2 outbound, x 3 walkway, x 4-5 inbound and staging; y 1 at the top, 18 at the bottom.
-- Two floors carry this one map: the live floor (occupancy NOT INITIALIZED, assign / move / release off, nothing imported)
-- and its test copy for synthetic pallets.
insert into nexus.warehouses (code, name, test, occupancy_state, moves_enabled, map_version, landmarks, layout) select w.code, w.name, w.test, w.state, w.test, 3,
  '[{"key":"exit","label":"Exit","at":"top-left","edge":"top","x":[1,2]},{"key":"dock","label":"Dock","at":"top-right","edge":"top","x":[4,5]},{"key":"walkway","label":"Walkway","at":"centre","x":[3,3]},{"key":"entrance","label":"Entrance","at":"bottom-centre","edge":"bottom","x":[3,3]},{"key":"prep","label":"Prep area","at":"bottom-right","edge":"bottom","x":[4,5]}]'::jsonb,
  '{"grid":{"cols":5,"rows":18,"origin":"top-left","x":"left to right","y":"top to bottom"},"blocks":[{"key":"outbound","label":"Outbound","side":"left","x":[1,2],"y":[1,18]},{"key":"walkway","label":"Walkway","side":"centre","x":[3,3],"y":[1,18]},{"key":"inbound","label":"Inbound","side":"right","x":[4,5],"y":[1,15]},{"key":"staging","label":"Staging","side":"right","x":[4,5],"y":[18,18]}]}'::jsonb
from (values ('HILLSBOROUGH', 'Hillsborough', false, 'not_initialized'), ('HILLSBOROUGH-TEST', 'Hillsborough (test floor, synthetic pallets only)', true, 'synthetic')) w(code, name, test, state);

insert into nexus.locations (code, kind, warehouse, zone, capacity, status, map_block, map_col, map_row, map_x, map_y)
select 'P-' || lpad(n::text, 2, '0'), 'pallet', w.code, side, 1, 'open', side, c, r, case when side = 'inbound' then 3 + c else c end, r
from nexus.warehouses w, generate_series(1, 66) n, lateral (select case when n <= 30 then 'inbound' else 'outbound' end side,
  case when n <= 30 then (n - 1) / 15 + 1 else (n - 31) / 18 + 1 end c, case when n <= 30 then (n - 1) % 15 + 1 else (n - 31) % 18 + 1 end r) x;
insert into nexus.locations (code, kind, warehouse, zone, capacity, status, map_block, map_col, map_row, map_x, map_y)
select v.code, v.kind, w.code, v.zone, null, 'open', v.block, v.col, 1, v.x, v.y from nexus.warehouses w,
  (values ('STG-01', 'staging', 'staging', 'staging', 1, 4, 18), ('STG-02', 'staging', 'staging', 'staging', 2, 5, 18), ('RCV-DOCK', 'dock', 'receiving', 'dock', 1, null, null)) v(code, kind, zone, block, col, x, y);
