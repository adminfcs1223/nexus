# Shared by backup.sh and restore-verify.sh. Read-only helpers: nothing here writes to the database it is pointed at.
PGSET="-c timezone=UTC -c datestyle=ISO -c extra_float_digits=1 -c bytea_output=hex"
q() { PGOPTIONS="$PGSET" psql -AtX -v ON_ERROR_STOP=1 "$1" -c "$2"; }

# The SQL that digests every nexus table as "table|rows|hash" lines. Built from the catalogue, so nothing has to be
# installed in the database. Left out on purpose:
#   key_handoff (temporary credential pickup rows: never part of a backup)
#   credential and housekeeping columns (key and token hashes, active flags, last-used times)
# so a backup with credentials and one without produce the same table digests.
digest_sql() {
  q "$1" "
    select string_agg(format(
      'select %L || ''|'' || count(*) || ''|'' || coalesce(md5(string_agg(md5(row(%s)::text), '''' order by md5(row(%s)::text))), ''-'') from nexus.%I', c.table_name, cols, cols, c.table_name), ' union all ' order by c.table_name)
    from (select table_name, string_agg(quote_ident(column_name), ', ' order by ordinal_position) cols
          from information_schema.columns
          where table_schema = 'nexus' and table_name <> 'key_handoff'
            and (table_name, column_name) not in (('integrations','key_hash'),('integrations','active'),('integrations','last_ok_at'),('integrations','last_error_at'),('integrations','last_error'),
                                                  ('operators','token_hash'),('operators','active'),('operators','last_used_at'))
            and table_name in (select relname from pg_class where relnamespace = 'nexus'::regnamespace and relkind = 'r')
          group by table_name) c"
}
digest() { q "$1" "$(digest_sql "$1")" | sort; }
CRED_SQL="select md5(coalesce((select string_agg(key_hash || active, ',' order by id) from nexus.integrations), '') || '/' || coalesce((select string_agg(token_hash || active, ',' order by id) from nexus.operators), ''))"
# function bodies, so a restore that lost or changed the rules is noticed
code_digest() { q "$1" "select md5(string_agg(p.proname || pg_get_function_identity_arguments(p.oid) || md5(p.prosrc), ',' order by p.proname, pg_get_function_identity_arguments(p.oid))) from pg_proc p where p.pronamespace = 'nexus'::regnamespace"; }
# the constraints that carry the safety rules: floor locks, one place per pallet, one history row per idempotency key
RULES_SQL="select md5(coalesce(string_agg(conrelid::regclass::text || ':' || contype::text || ':' || pg_get_constraintdef(oid), ';' order by conrelid::regclass::text, pg_get_constraintdef(oid)), '')) from pg_constraint where connamespace = 'nexus'::regnamespace"
