-- The approved v1 canonical warehouse map (the layout Nexus draws today) as the location registry.
-- Left block = outbound side by the Exit (two lines of 18), right block = inbound side under the Dock (two lines of 18),
-- two staging spots by the prep area, one dock. Which code sits in which square follows today's drawing.
-- Three things on the drawing do not match the live location records; they are loaded as 'unavailable' or flagged, not guessed:
--   P-65..P-72 and STG-02 are drawn but were never set up as locations; zones are relabelled from "bulk" to the side they are drawn on.
insert into nexus.locations (code, kind, warehouse, zone, capacity, status, status_reason, map_block, map_col, map_row)
select 'P-' || lpad(n::text, 2, '0'), 'pallet', 'HILLSBOROUGH', case when n <= 36 then 'inbound' else 'outbound' end, 1,
  case when n <= 64 then 'open' else 'unavailable' end, case when n > 64 then 'Drawn on the v1 map; not set up as a location yet' end,
  case when n <= 36 then 'inbound' else 'outbound' end, ((n - 1) % 36) / 18 + 1, ((n - 1) % 18) + 1
from generate_series(1, 72) n;
insert into nexus.locations (code, kind, warehouse, zone, capacity, status, status_reason, map_block, map_col, map_row) values
  ('STG-01', 'staging', 'HILLSBOROUGH', 'staging', null, 'open', null, 'staging', 1, 1),
  ('STG-02', 'staging', 'HILLSBOROUGH', 'staging', null, 'unavailable', 'Drawn on the v1 map; not set up as a location yet', 'staging', 2, 1),
  ('RCV-DOCK', 'dock', 'HILLSBOROUGH', 'receiving', null, 'open', null, 'dock', 1, 1);
