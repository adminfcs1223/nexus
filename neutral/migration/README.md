# From the old Nexus site's position numbering to map version 4

Nothing here has been applied. The old site (live on ShipBay's production database) is unchanged and still uses its own numbering.

`old-to-v4.csv` maps every old code to the new code for the same drawn square (same side, same column, same row).

- Old drawing: inbound P-01..P-18 and P-19..P-36; outbound P-37..P-54 and P-55..P-72 (P-65..P-72 and STG-02 were drawn but never existed as records).
- Map version 4: inbound P-01..P-15 and P-16..P-30; outbound P-31..P-48 and P-49..P-66; STG-01 and STG-02 beneath P-15 and P-30.
- Only P-01..P-15 keep both their code and their square. Every code from P-16 to P-66 exists in both schemes and names a DIFFERENT square.
  That is the hazard: an old label or an old record read under the new map points at the wrong place without any error.
- Old inbound rows 16 to 18 (old P-16..P-18 and P-34..P-36) are not pallet positions any more.

Caveat: which old code sat in which square was an assumption in the old drawing, never confirmed on the floor. The mapping is by
drawn square. Where an old label is physically posted, the label's actual place decides, not this table.

Rules for the changeover
1. Old occupancy is not migrated. It was test data. The new floor starts from the physical count.
2. The mapping is for people and for relabeling: finding where an old label or an old paper record points. It is not an import.
3. Old position labels come off the floor before the count. A floor with both schemes posted cannot be counted safely.
4. The old site is retired or frozen (read-only) in a separately approved step, before real pallets are tracked in the new Nexus.
   Until then nobody should read a position from the old site and act on it on the relabeled floor.
5. ShipBay's own records of the old position codes stay in ShipBay's database as history; they are not rewritten.
