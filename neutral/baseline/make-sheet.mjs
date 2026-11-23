// Writes the blank count sheet (one row per position on the approved map): node neutral/baseline/make-sheet.mjs > count-sheet.csv
import { POSITIONS } from './validate.mjs';
console.log(['position,state,company,pallet_id,counted_by,counted_at,note', ...POSITIONS.map((p) => `${p.code},,,,,,`)].join('\n'));
