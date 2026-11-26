-- Credential handling after the 2026-11-25 exposure report. Loaded after 012.
-- Plaintext keys no longer wait in a table. A replacement key is created at the moment the owner asks for it and is shown
-- once, in the answer to that one statement; only its hash is stored. The old pickup table is emptied and closed.
--   select nexus.credential_issue_once('SOULED', 'movement');     -- run by the owner in the SQL editor, one at a time
--   select nexus.credential_retire_replaced('SOULED', 'movement'); -- after the new key is seen working
create or replace function nexus.credential_issue_once(p_company text, p_purpose text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare c companies; v_scopes text[]; v_old text; v_new text; v_env text; k text; v_floor constant text := 'HILLSBOROUGH';
begin
  select * into c from companies where code = upper(btrim(coalesce(p_company, ''))) and active;
  if c.id is null then return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'company is SOULED or SHIPBAY'); end if;
  if p_purpose = 'movement' then v_scopes := array['read', 'move']; v_old := lower(c.code) || '-production'; v_env := 'NEXUS_PRODUCTION_API_KEY';
  elsif p_purpose = 'read' then v_scopes := array['read']; v_old := lower(c.code) || '-production-read'; v_env := 'NEXUS_PRODUCTION_READ_KEY';
  else return jsonb_build_object('ok', false, 'error', 'bad_request', 'message', 'purpose is movement or read'); end if;
  v_new := v_old || '-r2';
  if exists (select 1 from integrations where company_id = c.id and source_system = v_new and warehouse = v_floor) then
    return jsonb_build_object('ok', false, 'error', 'already_issued', 'message', 'This replacement was already issued and its key was shown once. If it was lost, ask for a new revision; it cannot be shown again.');
  end if;
  k := integration_create('owner rotation ' || session_user, c.id, v_new, v_floor, v_scopes);
  insert into audit_log (actor, action, warehouse, target, after) values ('db:' || session_user, 'credential_replacement_issued', v_floor, v_new, jsonb_build_object('company', c.code, 'purpose', p_purpose, 'replaces', v_old, 'sha256_prefix', left(_hash(k), 8)));
  return jsonb_build_object('ok', true, 'company', c.code, 'purpose', p_purpose, 'install_as_secret', v_env, 'key', k, 'sha256_prefix', left(_hash(k), 8),
    'note', 'Shown once. Copy the key value straight into that server-side secret, then close this result. The old key keeps working until it is retired.');
end $$;
-- Retire the old key of a pair, only once its replacement has been seen working from the application.
create or replace function nexus.credential_retire_replaced(p_company text, p_purpose text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare c companies; v_old text; n integrations; o integrations;
begin
  select * into c from companies where code = upper(btrim(coalesce(p_company, '')));
  v_old := lower(coalesce(c.code, '')) || case p_purpose when 'movement' then '-production' when 'read' then '-production-read' end;
  select * into o from integrations where company_id = c.id and source_system = v_old and warehouse = 'HILLSBOROUGH';
  select * into n from integrations where company_id = c.id and source_system = v_old || '-r2' and warehouse = 'HILLSBOROUGH';
  if o.id is null or n.id is null then return jsonb_build_object('ok', false, 'error', 'not_found', 'message', 'no such pair of credentials'); end if;
  if not n.active or n.last_ok_at is null then return jsonb_build_object('ok', false, 'error', 'replacement_not_verified', 'message', 'the replacement has not made a successful call yet; the old key stays active'); end if;
  if not o.active then return jsonb_build_object('ok', true, 'already_retired', true); end if;
  update integrations set active = false where id = o.id;
  insert into audit_log (actor, action, warehouse, target, after) values ('db:' || session_user, 'credential_retired', 'HILLSBOROUGH', v_old, jsonb_build_object('company', c.code, 'replaced_by', v_old || '-r2', 'old_last_used', o.last_ok_at, 'replacement_first_seen_working', n.last_ok_at));
  return jsonb_build_object('ok', true, 'retired', v_old, 'replacement', v_old || '-r2', 'old_last_used', o.last_ok_at);
end $$;
-- Empty the old pickup table (the keys in it stay valid until retired; only the stored copies go) and close it for good.
create or replace function nexus.key_handoff_close(p_actor text) returns jsonb language plpgsql set search_path to 'nexus' as $$
declare v_labels jsonb; n integer;
begin
  select coalesce(jsonb_agg(label order by label), '[]') into v_labels from key_handoff;
  delete from key_handoff; get diagnostics n = row_count;
  insert into audit_log (actor, action, after) values (p_actor, 'key_handoff_closed', jsonb_build_object('stored_copies_removed', n, 'labels', v_labels));
  return jsonb_build_object('ok', true, 'stored_copies_removed', n);
end $$;
create or replace function nexus._key_handoff_closed() returns trigger language plpgsql as $$ begin raise exception 'the key pickup table is closed: keys are issued with nexus.credential_issue_once and never stored'; end $$;
create or replace trigger key_handoff_closed before insert or update on nexus.key_handoff for each row execute function nexus._key_handoff_closed();
revoke all on function nexus.credential_issue_once(text, text) from public; revoke all on function nexus.credential_retire_replaced(text, text) from public;
revoke all on function nexus.key_handoff_close(text) from public; revoke all on function nexus._key_handoff_closed() from public;
