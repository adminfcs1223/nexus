// Reference check for a system reading Nexus: does an occupancy answer agree with the map it was drawn from?
// Both companies' systems can mirror this logic. It takes the two answers exactly as Nexus sends them
// (GET /v1/map and GET /v1/occupancy) and reads nothing else.
//
// Three kinds of location, told apart by the map itself, never by a hard-coded list of codes:
//   destination   a map position with a square (x and y): the pallet and staging positions a pallet can be put away to
//   non-drawn     a map position WITHOUT a square (today only the dock, kind "dock"): part of the registry, not a put-away
//                 destination. It is expected in the occupancy answer and is fine while nothing stands there.
//   unknown       a code in the occupancy answer that the map does not list at all. Never ignored.
// Nothing is skipped silently: every non-destination entry is either explained (empty, registry-only) or an error.
export function checkOccupancy(map, occupancy) {
  const errors = []; const add = (code, location, message) => errors.push({ code, location, message });
  if (!map?.ok || !Array.isArray(map.positions)) return { ok: false, errors: [{ code: 'bad_map', location: null, message: 'the map answer is not usable' }] };
  if (!occupancy?.ok || !Array.isArray(occupancy.locations)) return { ok: false, errors: [{ code: 'bad_occupancy', location: null, message: 'the occupancy answer is not usable' }] };
  if (occupancy.warehouse !== map.warehouse) add('floor_mismatch', null, `the map is for ${map.warehouse}, the occupancy answer for ${occupancy.warehouse}`);
  const known = new Map(map.positions.map((p) => [p.code, p])); const isDestination = (p) => p && Number.isInteger(p.x) && Number.isInteger(p.y);
  const seen = new Set(); const destinations = []; const registryOnly = [];
  for (const l of occupancy.locations) {
    const code = l?.code; const used = Number(l?.used);
    if (typeof code !== 'string' || code !== code.trim().toUpperCase()) { add('occupancy_bad_code', String(code), 'a location code is missing or not in the map\'s form'); continue; }
    if (seen.has(code)) { add('occupancy_duplicate_location', code, `${code} appears twice`); continue; } seen.add(code);
    if (!Number.isInteger(used) || used < 0) add('occupancy_bad_count', code, `${code} has no usable count`);
    const p = known.get(code);
    if (!p) { add('occupancy_unknown_location', code, `${code} is not on the map${used > 0 ? ` and ${used} pallet(s) stand there` : ''}`); continue; }
    if (p.kind !== l.kind) add('occupancy_kind_mismatch', code, `${code} is ${p.kind} on the map and ${l.kind} in the occupancy answer`);
    if (isDestination(p)) { destinations.push(l); if (l.capacity != null && used > l.capacity) add('occupancy_over_capacity', code, `${code} holds ${l.capacity} and ${used} stand there`); continue; }
    // on the map, with no square: not somewhere a pallet may be shown. Empty is expected; occupied is a real problem.
    if (used > 0) add('occupancy_off_map_occupied', code, `${used} pallet(s) stand at ${code}, which is not a put-away destination`);
    else registryOnly.push(code);
  }
  for (const p of map.positions) if (!seen.has(p.code)) add(isDestination(p) ? 'occupancy_missing_destination' : 'occupancy_missing_location', p.code, `${p.code} is on the map and missing from the occupancy answer`);
  return { ok: errors.length === 0, destinations: destinations.length, registry_only: registryOnly.sort(), occupied: destinations.filter((l) => l.used > 0).map((l) => l.code).sort(), errors };
}
